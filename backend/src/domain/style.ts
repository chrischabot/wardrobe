import type { CommandOf, StyleDocument, StyleRule } from '@garderobe/contracts';
import { parseJson, rawPredicate } from './db.js';
import { DomainError, notFound } from './errors.js';
import { newId } from './ids.js';
import { sha256Hex, utf8ByteLength } from './hash.js';
import { assertPrincipal, type Principal } from './principal.js';
import { loadActiveRestrictions, rowToRestriction } from './restrictions.js';
import type { CommandPlan, HandlerContext } from './commands/types.js';

/**
 * Style documents and machine rules (spec section 6).
 *
 * The personal document is stored verbatim (byte-exact) with its SHA-256; every save creates a new
 * version. Machine rules cite a passage by section and verbatim quote. When a new version no longer
 * contains a rule's quote the rule is flagged passage_status = 'missing' for review; it is never
 * rewritten or deleted automatically. Temporary briefs add dated rules without touching the document.
 */

export const PROFILE_PRECEDENCE_STATEMENT =
  'Precedence: newer owner-confirmed restrictions, measurements, sizes and current physical state supersede conflicting older profile passages; the profile prose governs taste. Unconfirmed model extractions never overrule owner-authored passages.';

export interface StyleDocumentRow {
  document_id: string;
  version: number;
  title: string;
  body: string;
  content_sha256: string;
  byte_length: number;
  is_demo: number;
  source: string;
  authored_on: string | null;
  imported_at: string;
  is_current: number;
}

export function rowToDocument(r: StyleDocumentRow): StyleDocument {
  return {
    documentId: r.document_id,
    version: r.version,
    title: r.title,
    body: r.body,
    contentSha256: r.content_sha256,
    byteLength: r.byte_length,
    isDemo: r.is_demo === 1,
    source: r.source as StyleDocument['source'],
    authoredOn: r.authored_on,
    importedAt: r.imported_at,
    isCurrent: r.is_current === 1,
  };
}

export interface StyleRuleRow {
  rule_id: string;
  rule_key: string;
  kind: string;
  strength: string;
  category: string;
  statement: string;
  interpretation: string;
  machine_json: string;
  exception_policy: string;
  document_id: string | null;
  document_version: number | null;
  passage_section: string | null;
  passage_quote: string | null;
  passage_status: string;
  overrides_rule_key: string | null;
  valid_from: string | null;
  valid_to: string | null;
  status: string;
  source: string;
  version: number;
}

export function rowToRule(r: StyleRuleRow): StyleRule {
  return {
    ruleId: r.rule_id,
    ruleKey: r.rule_key,
    kind: r.kind as StyleRule['kind'],
    strength: r.strength as StyleRule['strength'],
    category: r.category as StyleRule['category'],
    statement: r.statement,
    interpretation: r.interpretation,
    machine: parseJson<Record<string, unknown>>(r.machine_json, {}),
    exceptionPolicy: r.exception_policy as StyleRule['exceptionPolicy'],
    documentId: r.document_id,
    documentVersion: r.document_version,
    passage: r.passage_section && r.passage_quote ? { section: r.passage_section, quote: r.passage_quote } : null,
    passageStatus: r.passage_status as StyleRule['passageStatus'],
    overridesRuleKey: r.overrides_rule_key,
    validFrom: r.valid_from,
    validTo: r.valid_to,
    status: r.status as StyleRule['status'],
    source: r.source,
    version: r.version,
  };
}

export async function loadCurrentDocument(db: D1Database, userId: string, documentId: string): Promise<StyleDocumentRow | null> {
  return db.prepare('SELECT * FROM style_documents WHERE user_id = ? AND document_id = ? AND is_current = 1').bind(userId, documentId).first<StyleDocumentRow>();
}

export async function getStyleDocument(db: D1Database, principal: Principal, documentId: string, version?: number): Promise<StyleDocument> {
  assertPrincipal(principal);
  const row = version
    ? await db.prepare('SELECT * FROM style_documents WHERE user_id = ? AND document_id = ? AND version = ?').bind(principal.userId, documentId, version).first<StyleDocumentRow>()
    : await loadCurrentDocument(db, principal.userId, documentId);
  if (!row) throw notFound('style_document', documentId);
  return verifiedDocument(row);
}

/**
 * The stored body is re-hashed on every read (ADV-06): a body changed in storage, by a bad migration
 * or a restore is served with integrity 'mismatch' (never under a hash it does not have silently).
 */
export async function verifiedDocument(row: StyleDocumentRow): Promise<StyleDocument> {
  const doc = rowToDocument(row);
  const ok = (await sha256Hex(row.body)) === row.content_sha256 && utf8ByteLength(row.body) === row.byte_length;
  return { ...doc, integrity: ok ? 'ok' : 'mismatch' };
}

export async function listStyleDocuments(db: D1Database, principal: Principal): Promise<StyleDocument[]> {
  assertPrincipal(principal);
  const { results } = await db.prepare('SELECT * FROM style_documents WHERE user_id = ? AND is_current = 1 ORDER BY imported_at').bind(principal.userId).all<StyleDocumentRow>();
  return Promise.all(results.map(verifiedDocument));
}

export async function listStyleRules(db: D1Database, principal: Principal, opts: { includeRetired?: boolean } = {}): Promise<StyleRule[]> {
  assertPrincipal(principal);
  const { results } = await db
    .prepare(`SELECT * FROM style_rules WHERE user_id = ? ${opts.includeRetired ? '' : "AND status <> 'retired'"} ORDER BY kind, rule_key`)
    .bind(principal.userId)
    .all<StyleRuleRow>();
  return results.map(rowToRule);
}

export interface StyleContext {
  documents: StyleDocument[];
  rules: StyleRule[];
  temporaryBriefs: StyleRule[];
  amendments: { amendmentId: string; documentId: string; text: string; createdAt: string }[];
  restrictions: ReturnType<typeof rowToRestriction>[];
  /** Rules whose dependency restriction has been lifted become applicable (e.g. sneaker + welted). */
  dormantRuleKeys: string[];
  precedence: string;
}

/**
 * Mandatory taste context for a date: complete current documents, active machine rules, temporary
 * briefs covering the date, active amendments and restrictions, plus the precedence statement.
 */
export async function getStyleContext(db: D1Database, principal: Principal, date: string): Promise<StyleContext> {
  assertPrincipal(principal);
  const documents = await listStyleDocuments(db, principal);
  const all = (await listStyleRules(db, principal)).filter((r) => r.status === 'active');
  const temporaryBriefs = all.filter((r) => r.kind === 'temporary_brief' && (!r.validFrom || r.validFrom <= date) && (!r.validTo || r.validTo >= date));
  const rules = all.filter((r) => r.kind !== 'temporary_brief');
  const restrictionRows = await loadActiveRestrictions(db, principal.userId);
  const activeRestrictionRuleKeys = new Set(restrictionRows.map((r) => r.rule_key).filter(Boolean));
  const dormantRuleKeys = rules
    .filter((r) => typeof r.machine.appliesWhenRestrictionLifted === 'string')
    .filter((r) => {
      const dependency = rules.find((x) => x.machine.restrictionSourceId === r.machine.appliesWhenRestrictionLifted);
      return dependency ? activeRestrictionRuleKeys.has(dependency.ruleKey) : false;
    })
    .map((r) => r.ruleKey);
  const { results: amendments } = await db
    .prepare("SELECT amendment_id, document_id, text, created_at FROM profile_amendments WHERE user_id = ? AND status = 'active' ORDER BY created_at")
    .bind(principal.userId)
    .all<{ amendment_id: string; document_id: string; text: string; created_at: string }>();
  return {
    documents,
    rules,
    temporaryBriefs,
    amendments: amendments.map((a) => ({ amendmentId: a.amendment_id, documentId: a.document_id, text: a.text, createdAt: a.created_at })),
    restrictions: restrictionRows.map(rowToRestriction),
    dormantRuleKeys,
    precedence: PROFILE_PRECEDENCE_STATEMENT,
  };
}

/** Statements creating a new current version of a document and re-checking rule passages. */
export async function planDocumentVersion(
  ctx: HandlerContext,
  current: StyleDocumentRow,
  body: string,
  title: string,
  source: 'owner_edit',
  amendment?: string,
): Promise<{ statements: D1PreparedStatement[]; newVersion: number; sha: string; missing: string[]; present: string[] }> {
  const userId = ctx.principal.userId;
  const newVersion = current.version + 1;
  const sha = await sha256Hex(body);
  const statements: D1PreparedStatement[] = [
    ctx.db.prepare('UPDATE style_documents SET is_current = 0 WHERE user_id = ? AND document_id = ? AND version = ?').bind(userId, current.document_id, current.version),
    ctx.db
      .prepare(
        `INSERT INTO style_documents (user_id, document_id, version, title, body, content_sha256, byte_length, is_demo, source, authored_on, imported_at, created_by_command, is_current)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
      )
      .bind(userId, current.document_id, newVersion, title, body, sha, utf8ByteLength(body), current.is_demo, source, ctx.now.slice(0, 10), ctx.now, ctx.commandId),
  ];
  const { results: rules } = await ctx.db
    .prepare("SELECT rule_id, rule_key, passage_quote FROM style_rules WHERE user_id = ? AND document_id = ? AND status = 'active' AND kind <> 'temporary_brief'")
    .bind(userId, current.document_id)
    .all<{ rule_id: string; rule_key: string; passage_quote: string | null }>();
  const missing: string[] = [];
  const present: string[] = [];
  for (const r of rules) {
    const ok = r.passage_quote !== null && body.includes(r.passage_quote);
    (ok ? present : missing).push(r.rule_key);
    statements.push(
      ok
        ? ctx.db.prepare("UPDATE style_rules SET passage_status = 'present', document_version = ? WHERE user_id = ? AND rule_id = ?").bind(newVersion, userId, r.rule_id)
        : ctx.db.prepare("UPDATE style_rules SET passage_status = 'missing' WHERE user_id = ? AND rule_id = ?").bind(userId, r.rule_id),
    );
  }
  if (amendment) {
    statements.push(
      ctx.db
        .prepare("INSERT INTO profile_amendments (user_id, amendment_id, document_id, text, status, source, command_id, created_at) VALUES (?, ?, ?, ?, 'active', 'owner_edit', ?, ?)")
        .bind(userId, newId('amd'), current.document_id, amendment, ctx.commandId, ctx.now),
    );
  }
  return { statements, newVersion, sha, missing, present };
}

export async function editStyleProfile(ctx: HandlerContext<CommandOf<'edit_style_profile'>>): Promise<CommandPlan> {
  const c = ctx.command;
  const userId = ctx.principal.userId;
  const current = await loadCurrentDocument(ctx.db, userId, c.documentId);
  if (!current) throw notFound('style_document', c.documentId);
  if (current.version !== c.baseVersion) {
    throw new DomainError('conflict', `My style was saved elsewhere (now version ${current.version}); reopen it before saving`, { currentVersion: current.version, baseVersion: c.baseVersion });
  }
  const plan = await planDocumentVersion(ctx, current, c.body, c.title ?? current.title, 'owner_edit', c.amendment);
  return {
    occurredAt: ctx.now,
    guards: [
      rawPredicate('(SELECT version FROM style_documents WHERE user_id = ? AND document_id = ? AND is_current = 1) = ?', [userId, c.documentId, c.baseVersion], 'style document base version'),
    ],
    statements: plan.statements,
    affected: [{ entityType: 'style_document', entityId: c.documentId, version: plan.newVersion, change: 'created' }],
    summary: `Saved My style as version ${plan.newVersion}.${plan.missing.length ? ` ${plan.missing.length} rule(s) cite passages no longer present and need review.` : ''}`,
    facts: { documentId: c.documentId, version: plan.newVersion, contentSha256: plan.sha, rulesNeedingReview: plan.missing },
    undo: { kind: 'revert_style_document', documentId: c.documentId, versionAfter: plan.newVersion, previousVersion: current.version },
    effects: [{ kind: 'search_index', external: false, operationKey: `index:style:${c.documentId}:${plan.newVersion}`, payload: { documentId: c.documentId, version: plan.newVersion } }],
  };
}

export async function setTemporaryBrief(ctx: HandlerContext<CommandOf<'set_temporary_brief'>>): Promise<CommandPlan> {
  const c = ctx.command;
  const userId = ctx.principal.userId;
  if (c.overridesRuleKey) {
    const rule = await ctx.db
      .prepare("SELECT rule_key, exception_policy, statement FROM style_rules WHERE user_id = ? AND rule_key = ? AND status = 'active' AND kind <> 'temporary_brief'")
      .bind(userId, c.overridesRuleKey)
      .first<{ rule_key: string; exception_policy: string; statement: string }>();
    if (!rule) throw new DomainError('not_found', `No active rule ${c.overridesRuleKey}`);
    if (rule.exception_policy !== 'owner_scoped') {
      throw new DomainError(
        'rule_admits_no_exception',
        rule.exception_policy === 'restriction_lift_only'
          ? `"${rule.statement}" changes only when its restriction is lifted by an explicit owner statement.`
          : `"${rule.statement}" admits no exception.`,
        { ruleKey: rule.rule_key, exceptionPolicy: rule.exception_policy },
      );
    }
  }
  const ruleId = newId('rule');
  return {
    occurredAt: ctx.now,
    guards: [],
    statements: [
      ctx.db
        .prepare(
          `INSERT INTO style_rules (user_id, rule_id, rule_key, kind, strength, category, statement, interpretation, machine_json, exception_policy, passage_status,
             overrides_rule_key, valid_from, valid_to, status, source, created_at, created_by_command)
           VALUES (?, ?, ?, 'temporary_brief', 'soft', 'day_brief', ?, ?, ?, 'owner_scoped', 'not_applicable', ?, ?, ?, 'active', 'owner_brief', ?, ?)`,
        )
        .bind(
          userId,
          ruleId,
          `brief.${ruleId}`,
          c.text,
          c.overridesRuleKey ? `Owner exception to ${c.overridesRuleKey} for ${c.validFrom}${c.validTo !== c.validFrom ? `–${c.validTo}` : ''} only; the profile and the rule are unchanged.` : 'Owner temporary brief for the stated dates only.',
          JSON.stringify(c.machine ?? {}),
          c.overridesRuleKey ?? null,
          c.validFrom,
          c.validTo,
          ctx.now,
          ctx.commandId,
        ),
    ],
    affected: [],
    summary: `Temporary brief for ${c.validFrom}${c.validTo !== c.validFrom ? `–${c.validTo}` : ''}: ${c.text}. My style is unchanged.`,
    facts: { ruleId, overridesRuleKey: c.overridesRuleKey ?? null, validFrom: c.validFrom, validTo: c.validTo },
    undo: { kind: 'retire_rule', ruleId },
    effects: [],
  };
}
