import { z } from 'zod';
import { AddItemCommand, type CommandReceipt } from '@garderobe/contracts';
import { CommandService } from '../domain/commands/service.js';
import { newId } from '../domain/ids.js';
import { assertPrincipal, type Principal } from '../domain/principal.js';
import { json } from '../domain/db.js';

/**
 * Owner-asserted additions (spec section 5, "Evidence and corrections"): garments the owner confirmed
 * he owns on 2026-09-29 ("All of them") that the May 2026 CSV lacks. They are created through the
 * explicit add_item command (never through the CSV import rows), described only by verbatim profile
 * passages; everything the profile does not state stays unknown and is listed as details needed.
 */

export const OWNER_ANSWER_SOURCE_SYSTEM = 'owner-answer-2026-09-29';
const PROFILE_OBSERVED_AT = '2026-09-13T23:00:00.000Z'; // profile second edition, 14 September 2026 (London)

const Passage = z.strictObject({ field: z.string().min(1).max(80), section: z.string().min(1), quote: z.string().min(1) });

export const OwnerAdditionsFile = z.strictObject({
  answer: z.strictObject({
    question: z.string(),
    answer: z.string(),
    answeredOn: z.iso.date(),
    observedAt: z.iso.datetime({ offset: true }),
    sourceRef: z.string().min(1).max(500),
    pieces: z.string(),
  }),
  additions: z
    .array(
      z.strictObject({
        key: z.string().regex(/^[a-z0-9_]+$/),
        resolvesIssue: z.string().min(3),
        item: AddItemCommand.omit({ type: true, explicit: true, facts: true, acquisition: true, quantity: true }),
        passages: z.array(Passage).min(1),
        unknownFields: z.array(z.string()).min(1),
        detailsNeeded: z.string().nullable(),
      }),
    )
    .min(1),
  openQuestions: z.array(z.strictObject({ key: z.string().regex(/^[a-z0-9_]+$/), detail: z.string().min(1) })),
});
export type OwnerAdditionsFile = z.infer<typeof OwnerAdditionsFile>;

/** Parses the additions file and checks every quote is verbatim in its profile section. */
export function parseOwnerAdditions(raw: unknown, profileText: string): OwnerAdditionsFile {
  const file = OwnerAdditionsFile.parse(raw);
  const keys = new Set<string>();
  for (const a of file.additions) {
    if (keys.has(a.key)) throw new Error(`Duplicate addition key ${a.key}`);
    keys.add(a.key);
    for (const p of a.passages) {
      const start = profileText.indexOf(`## ${p.section}`);
      const next = start >= 0 ? profileText.indexOf('\n## ', start + 3) : -1;
      const section = start >= 0 ? profileText.slice(start, next === -1 ? undefined : next) : '';
      if (!section.includes(p.quote)) throw new Error(`Addition ${a.key}: quote not found in section "${p.section}": ${p.quote}`);
    }
  }
  return file;
}

export function additionIdempotencyKey(key: string): string {
  return `${OWNER_ANSWER_SOURCE_SYSTEM}:${key}`;
}

/** Garments restricted by the profile's sneakers-only rule (mirrors the restriction scope). */
export function additionRestricted(a: OwnerAdditionsFile['additions'][number]): boolean {
  const attrs = (a.item.attributes ?? {}) as Record<string, unknown>;
  return a.item.category === 'shoes' || a.item.category === 'boots' || attrs.construction === 'welted' || attrs.model === '990v6';
}

export interface OwnerAdditionsResult {
  receipts: CommandReceipt[];
  created: number;
  replayed: number;
  garmentIds: Record<string, string>;
  issuesResolved: string[];
  detailsNeededRecorded: number;
}

export async function applyOwnerAssertedAdditions(db: D1Database, principal: Principal, file: OwnerAdditionsFile, opts: { now?: () => string } = {}): Promise<OwnerAdditionsResult> {
  assertPrincipal(principal);
  const service = new CommandService(db, principal, opts.now ? { now: opts.now } : {});
  const receipts: CommandReceipt[] = [];
  const garmentIds: Record<string, string> = {};
  for (const a of file.additions) {
    const facts = [
      { field: 'owner_assertion', value: `Owner confirmed he owns this and asked for it to be added ("${file.answer.answer}").`, sourceKind: 'owner_statement' as const, sourceRef: file.answer.sourceRef, observedAt: file.answer.observedAt },
      ...a.passages.map((p) => ({ field: p.field, value: p.quote, sourceKind: 'owner_statement' as const, sourceRef: `owner-profile.md §${p.section}`, observedAt: PROFILE_OBSERVED_AT })),
      { field: 'unknown_fields', value: a.unknownFields, sourceKind: 'owner_statement' as const, sourceRef: file.answer.sourceRef, observedAt: file.answer.observedAt },
    ];
    const receipt = await service.execute({
      idempotencyKey: additionIdempotencyKey(a.key),
      source: 'conversation',
      command: {
        type: 'add_item',
        explicit: true,
        ...a.item,
        acquisition: 'owned',
        quantity: 1,
        condition: 'unknown',
        attributes: { ...(a.item.attributes ?? {}), ownerAsserted: true, ownerAnswer: file.answer.answeredOn },
        notes: `Owner-asserted ${file.answer.answeredOn}; described only from the owner profile. Unknown: ${a.unknownFields.join('; ')}.`,
        facts,
      },
    });
    if (receipt.outcome !== 'committed' && receipt.outcome !== 'merged') {
      throw new Error(`Owner-asserted addition ${a.key} failed: ${receipt.error?.code} ${receipt.error?.message}`);
    }
    receipts.push(receipt);
    garmentIds[a.key] = receipt.facts.garmentId as string;
  }

  // Resolve the migration issues the answer settles, and record what is still needed.
  const now = opts.now ? opts.now() : new Date().toISOString();
  const byIssue = new Map<string, string[]>();
  for (const a of file.additions) byIssue.set(a.resolvesIssue, [...(byIssue.get(a.resolvesIssue) ?? []), a.item.name]);
  const statements: D1PreparedStatement[] = [];
  for (const [issueKey, names] of byIssue) {
    statements.push(
      db
        .prepare("UPDATE migration_issues SET status = 'resolved', resolved_at = ?, resolution = ? WHERE user_id = ? AND issue_key = ? AND status = 'open'")
        .bind(now, `Resolved by the owner's answer of ${file.answer.answeredOn} ("${file.answer.answer}"): added ${names.join(', ')}.`, principal.userId, issueKey),
    );
  }
  const details = [
    ...file.additions.filter((a) => a.detailsNeeded).map((a) => ({ key: `details_needed:${a.key}`, entityId: garmentIds[a.key] ?? null, detail: `${a.item.name}: ${a.detailsNeeded}` })),
    ...file.openQuestions.map((q) => ({ key: `open_question:${q.key}`, entityId: null, detail: q.detail })),
  ];
  for (const d of details) {
    statements.push(
      db
        .prepare('INSERT OR IGNORE INTO migration_issues (user_id, issue_id, source_system, issue_key, kind, severity, entity_id, detail, evidence_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .bind(principal.userId, newId('iss'), OWNER_ANSWER_SOURCE_SYSTEM, d.key, d.key.startsWith('details') ? 'details_needed' : 'open_question', 'review', d.entityId, d.detail, json({ answeredOn: file.answer.answeredOn }), now),
    );
  }
  const results = await db.batch(statements);
  const resolved = [...byIssue.keys()].filter((_, i) => (results[i]?.meta.changes ?? 0) > 0);
  const detailsNeededRecorded = results.slice(byIssue.size).reduce((n, r) => n + (r.meta.changes ?? 0), 0);
  return {
    receipts,
    created: receipts.filter((r) => !r.replayed).length,
    replayed: receipts.filter((r) => r.replayed).length,
    garmentIds,
    issuesResolved: resolved,
    detailsNeededRecorded,
  };
}
