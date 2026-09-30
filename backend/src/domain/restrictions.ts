import type { CommandOf, Restriction, RestrictionScope } from '@garderobe/contracts';
import { json, parseJson, versionIs } from './db.js';
import { DomainError, notFound } from './errors.js';
import { newId } from './ids.js';
import { assertPrincipal, OWNER_CHANNELS, type Principal } from './principal.js';
import { requireGarments, type GarmentRow } from './records.js';
import { revalidationEffect, type CommandPlan, type HandlerContext } from './commands/types.js';
import { healingEvidence, parseOwnerEvidence } from './healing.js';

/** `Restriction lifted on the owner's words (mcp): “…”. <reason>.` — the owner's words first, quoted once. */
export function liftSummary(reason: string, evidence: string): string {
  const parsed = parseOwnerEvidence(evidence);
  const words = (parsed ? parsed.words : evidence).trim();
  return `Restriction lifted on the owner's words${parsed ? ` (${parsed.channel})` : ''}: \u201c${words}\u201d. Was: ${reason}.`;
}

/**
 * Time-bounded restrictions (spec section 5). An expected end is informational: a restriction stays
 * in force until the evidence it requires arrives. Nothing here expires a restriction by time.
 */

export interface RestrictionRow {
  restriction_id: string;
  kind: string;
  scope_json: string;
  reason: string;
  starts_at: string;
  expected_end: string | null;
  required_evidence: string;
  rule_key: string | null;
  lifted_at: string | null;
  lift_evidence: string | null;
  version: number;
}

export function rowToRestriction(r: RestrictionRow): Restriction {
  return {
    restrictionId: r.restriction_id,
    kind: r.kind as Restriction['kind'],
    scope: parseJson<RestrictionScope>(r.scope_json, {} as RestrictionScope),
    reason: r.reason,
    startsAt: r.starts_at,
    expectedEnd: r.expected_end,
    requiredEvidence: r.required_evidence as Restriction['requiredEvidence'],
    liftedAt: r.lifted_at,
    liftEvidence: r.lift_evidence,
    version: r.version,
  };
}

type GarmentLike = Pick<GarmentRow, 'garment_id' | 'category' | 'roles_json' | 'attributes_json'>;

/** Union semantics: garmentIds OR categories OR roles OR any attribute equality. */
export function restrictionMatches(scope: RestrictionScope, g: GarmentLike): boolean {
  if (scope.garmentIds?.includes(g.garment_id)) return true;
  if (scope.categories?.includes(g.category as never)) return true;
  const roles = parseJson<string[]>(g.roles_json, []);
  if (scope.roles?.some((r) => roles.includes(r))) return true;
  if (scope.attributes) {
    const attrs = parseJson<Record<string, unknown>>(g.attributes_json, {});
    for (const [k, v] of Object.entries(scope.attributes)) if (attrs[k] !== undefined && String(attrs[k]) === v) return true;
  }
  return false;
}

export async function loadActiveRestrictions(db: D1Database, userId: string): Promise<RestrictionRow[]> {
  const { results } = await db.prepare('SELECT * FROM restrictions WHERE user_id = ? AND lifted_at IS NULL ORDER BY starts_at').bind(userId).all<RestrictionRow>();
  return results;
}

export async function listRestrictions(db: D1Database, principal: Principal, opts: { includeLifted?: boolean } = {}): Promise<Restriction[]> {
  assertPrincipal(principal);
  const { results } = await db
    .prepare(`SELECT * FROM restrictions WHERE user_id = ? ${opts.includeLifted ? '' : 'AND lifted_at IS NULL'} ORDER BY starts_at`)
    .bind(principal.userId)
    .all<RestrictionRow>();
  return results.map(rowToRestriction);
}

export async function setRestriction(ctx: HandlerContext<CommandOf<'set_restriction'>>): Promise<CommandPlan> {
  const c = ctx.command;
  const userId = ctx.principal.userId;
  if (c.scope.garmentIds?.length) await requireGarments(ctx.db, userId, c.scope.garmentIds);
  const at = c.occurredAt ? new Date(c.occurredAt).toISOString() : ctx.now;
  const restrictionId = newId('rst');
  return {
    occurredAt: at,
    guards: [],
    statements: [
      ctx.db
        .prepare(
          `INSERT INTO restrictions (user_id, restriction_id, kind, scope_json, reason, starts_at, expected_end, required_evidence, created_by_command, version)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
        )
        .bind(userId, restrictionId, c.kind, json(c.scope), c.reason, at, c.expectedEnd ?? null, c.requiredEvidence, ctx.commandId),
    ],
    affected: [{ entityType: 'restriction', entityId: restrictionId, version: 1, change: 'created' }],
    summary: `Restriction set (${c.kind.replace('_', ' ')}): ${c.reason}.${c.expectedEnd ? ` Expected end ${c.expectedEnd} is not a release; it stays until ${c.requiredEvidence.replace('_', ' ')}.` : ''}`,
    facts: { restrictionId, kind: c.kind, scope: c.scope },
    undo: { kind: 'lift_restriction', restrictionId, versionAfter: 1 },
    effects: [revalidationEffect(ctx.commandId, c.scope.garmentIds ?? [], 'restriction_set')],
  };
}

export async function liftRestriction(ctx: HandlerContext<CommandOf<'lift_restriction'>>): Promise<CommandPlan> {
  const c = ctx.command;
  const userId = ctx.principal.userId;
  const r = await ctx.db.prepare('SELECT * FROM restrictions WHERE user_id = ? AND restriction_id = ?').bind(userId, c.restrictionId).first<RestrictionRow>();
  if (!r) throw notFound('restriction', c.restrictionId);
  if (r.lifted_at) throw new DomainError('invalid_state', 'That restriction has already been lifted', { liftedAt: r.lifted_at });
  // The evidence must come from the owner through an owner channel; scheduled work, imports and
  // calendar text can never release a restriction (elapsed time is not evidence).
  if (!OWNER_CHANNELS.includes(ctx.envelope.source) || ctx.principal.authenticatedBy === 'scheduler') {
    throw new DomainError('evidence_required', `Only an explicit owner statement can lift this restriction (required: ${r.required_evidence.replace('_', ' ')})`, {
      source: ctx.envelope.source,
      requiredEvidence: r.required_evidence,
    });
  }
  const at = c.occurredAt ? new Date(c.occurredAt).toISOString() : ctx.now;
  // The healing restriction lifts only on the owner's own first-person statement that his feet have
  // healed (profile section 8); elapsed time, appointments or a third party's words are not that.
  if (r.kind === 'healing' && !healingEvidence(c.evidence)) {
    throw new DomainError('evidence_required', 'The healing restriction lifts only when the owner says, in his own words, that his feet have healed (for example “My feet have healed”)', {
      requiredEvidence: r.required_evidence,
    });
  }
  return {
    occurredAt: at,
    guards: [versionIs(userId, 'restriction', r.restriction_id, r.version)],
    statements: [
      ctx.db
        .prepare('UPDATE restrictions SET lifted_at = ?, lift_evidence = ?, lifted_by_command = ?, version = version + 1 WHERE user_id = ? AND restriction_id = ?')
        .bind(at, c.evidence, ctx.commandId, userId, r.restriction_id),
    ],
    affected: [{ entityType: 'restriction', entityId: r.restriction_id, version: r.version + 1, change: 'updated' }],
    // The owner's words come first and are quoted once, so a shortened summary still shows them
    // (simulation finding D5: the old form nested the evidence's own quotes and put the long
    // restriction reason first, so a 200-character cut left only `(owner: "Owner, mcp: "`).
    summary: liftSummary(r.reason, c.evidence),
    facts: { restrictionId: r.restriction_id, ruleKey: r.rule_key, evidence: c.evidence },
    undo: { kind: 'reinstate_restriction', restrictionId: r.restriction_id, versionAfter: r.version + 1 },
    effects: [revalidationEffect(ctx.commandId, parseJson<RestrictionScope>(r.scope_json, {} as RestrictionScope).garmentIds ?? [], 'restriction_lifted')],
  };
}
