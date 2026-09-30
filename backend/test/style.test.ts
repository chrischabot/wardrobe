import { describe, expect, it } from 'vitest';
import { db, newOwner, ok, run, service, envelope, OWNER_SOURCES } from './helpers/fixtures.js';
import { estimateAvailability, getStyleContext, getStyleDocument, listStyleDocuments, sha256Hex, systemPrincipal, PROFILE_PRECEDENCE_STATEMENT } from '../src/domain/index.js';
import { SPEC_PROFILE_SHA256 } from '../src/import/index.js';

describe('style profile versions', () => {
  it('saving My style creates a new verbatim version, flags rules whose passage disappeared, and undo restores the exact original', async () => {
    const { principal } = await newOwner();
    const [doc] = await listStyleDocuments(db(), principal);
    const quote = '**Never fall back to navy** when a piece is swapped out. He calls it boring, and he is right about his own wardrobe.';
    const edited = OWNER_SOURCES.profileText.replace(quote, '**Navy is fine as a swap when nothing else fits.**');
    const saved = await ok(principal, { type: 'edit_style_profile', documentId: doc!.documentId, baseVersion: 1, body: edited, amendment: 'Relaxed the navy rule (owner edit)' });
    expect(saved.facts.version).toBe(2);
    expect(saved.facts.rulesNeedingReview).toEqual(['hard.never_fall_back_to_navy']);
    const v2 = await getStyleDocument(db(), principal, doc!.documentId);
    expect(v2.body).toBe(edited);
    expect(v2.contentSha256).toBe(await sha256Hex(edited));
    const v1 = await getStyleDocument(db(), principal, doc!.documentId, 1);
    expect(v1.body).toBe(OWNER_SOURCES.profileText);
    expect(v1.isCurrent).toBe(false);
    const rules = await db().prepare('SELECT rule_key, passage_status, document_version FROM style_rules WHERE user_id = ?').bind(principal.userId).all<{ rule_key: string; passage_status: string; document_version: number }>();
    const navy = rules.results.find((r) => r.rule_key === 'hard.never_fall_back_to_navy')!;
    expect(navy).toMatchObject({ passage_status: 'missing', document_version: 1 });
    expect(rules.results.filter((r) => r.passage_status === 'present').every((r) => r.document_version === 2)).toBe(true);
    const ctx = await getStyleContext(db(), principal, '2026-10-07');
    expect(ctx.amendments.map((a) => a.text)).toEqual(['Relaxed the navy rule (owner edit)']);
    // A save against the old version conflicts.
    const stale = await run(principal, { type: 'edit_style_profile', documentId: doc!.documentId, baseVersion: 1, body: 'x' });
    expect(stale.outcome).toBe('conflict');
    // Undo writes version 3 with the original text, byte-exact.
    await ok(principal, { type: 'undo', targetCommandId: saved.commandId });
    const v3 = await getStyleDocument(db(), principal, doc!.documentId);
    expect(v3.version).toBe(3);
    expect(v3.body).toBe(OWNER_SOURCES.profileText);
    expect(v3.contentSha256).toBe(SPEC_PROFILE_SHA256);
    const navyAfter = await db().prepare("SELECT passage_status FROM style_rules WHERE user_id = ? AND rule_key = 'hard.never_fall_back_to_navy'").bind(principal.userId).first<{ passage_status: string }>();
    expect(navyAfter!.passage_status).toBe('present');
  });

  it('a one-day exception is a dated temporary brief and never rewrites the profile', async () => {
    const { principal } = await newOwner();
    const [doc] = await listStyleDocuments(db(), principal);
    const brief = await ok(principal, { type: 'set_temporary_brief', text: 'Happy to repeat the walnut chinos today', validFrom: '2026-10-07', validTo: '2026-10-07', overridesRuleKey: 'hard.variety_seven_days' });
    expect(brief.summary).toContain('My style is unchanged');
    const after = await getStyleDocument(db(), principal, doc!.documentId);
    expect(after.version).toBe(1);
    expect(after.contentSha256).toBe(SPEC_PROFILE_SHA256);
    const today = await getStyleContext(db(), principal, '2026-10-07');
    expect(today.temporaryBriefs.map((b) => b.overridesRuleKey)).toEqual(['hard.variety_seven_days']);
    expect((await getStyleContext(db(), principal, '2026-10-08')).temporaryBriefs).toHaveLength(0);
    expect(today.rules.find((r) => r.ruleKey === 'hard.variety_seven_days')!.status).toBe('active');
    await ok(principal, { type: 'undo', targetCommandId: brief.commandId });
    expect((await getStyleContext(db(), principal, '2026-10-07')).temporaryBriefs).toHaveLength(0);
  });

  it('refuses exceptions to rules that admit none', async () => {
    const { principal } = await newOwner();
    const socks = await run(principal, { type: 'set_temporary_brief', text: 'Sockless loafers today', validFrom: '2026-10-07', validTo: '2026-10-07', overridesRuleKey: 'hard.socks_always' });
    expect(socks.error?.code).toBe('rule_admits_no_exception');
    const welted = await run(principal, { type: 'set_temporary_brief', text: 'Wear the Paraboots today', validFrom: '2026-10-07', validTo: '2026-10-07', overridesRuleKey: 'hard.sneakers_only_until_healed' });
    expect(welted.error?.code).toBe('rule_admits_no_exception');
    expect(welted.summary).toContain('explicit owner statement');
  });

  it('provides the complete profile, rules and precedence statement as mandatory context', async () => {
    const { principal } = await newOwner();
    const ctx = await getStyleContext(db(), principal, '2026-10-07');
    expect(ctx.documents[0]!.body).toBe(OWNER_SOURCES.profileText);
    expect(ctx.rules).toHaveLength(41);
    expect(ctx.precedence).toBe(PROFILE_PRECEDENCE_STATEMENT);
    expect(ctx.restrictions).toHaveLength(1);
    expect(ctx.dormantRuleKeys).toEqual(['hard.sneaker_and_welted_alternative']);
  });
});

describe('sneakers-only restriction lifecycle', () => {
  it('cannot be lifted by scheduled work, imports, calendar text or elapsed time; lifts on an explicit owner statement', async () => {
    const { principal, byName } = await newOwner();
    const ctx = await getStyleContext(db(), principal, '2026-10-07');
    const restrictionId = ctx.restrictions[0]!.restrictionId;
    const scheduler = await service(systemPrincipal(principal.userId)).execute(envelope({ type: 'lift_restriction', restrictionId, evidence: 'Six months have passed' }, { source: 'system' }));
    expect(scheduler.error?.code).toBe('evidence_required');
    for (const source of ['calendar', 'import', 'system'] as const) {
      expect((await run(principal, { type: 'lift_restriction', restrictionId, evidence: 'Physio appointment done' }, { source })).error?.code).toBe('evidence_required');
    }
    // A year later, nothing has changed without evidence.
    const later = await estimateAvailability(db(), principal, { targetDate: '2027-10-07', asOf: '2027-10-06T06:00:00.000Z', garmentIds: [await byName('Paraboot Michael Cerf')] });
    expect(later[0]!.eligible).toBe(false);
    const lifted = await ok(principal, { type: 'lift_restriction', restrictionId, evidence: 'My feet have healed' }, { source: 'conversation' });
    expect(lifted.facts.ruleKey).toBe('hard.sneakers_only_until_healed');
    const now = await estimateAvailability(db(), principal, { targetDate: '2026-10-08', asOf: '2026-10-07T06:00:00.000Z', garmentIds: [await byName('Paraboot Michael Cerf')] });
    expect(now[0]!.eligible).toBe(true);
    expect((await getStyleContext(db(), principal, '2026-10-08')).dormantRuleKeys).toEqual([]);
    // Undo puts the restriction back in force.
    await ok(principal, { type: 'undo', targetCommandId: lifted.commandId });
    expect((await getStyleContext(db(), principal, '2026-10-08')).restrictions).toHaveLength(1);
  });

  it('the lift receipt’s summary leads with the owner’s exact words, so a shortened summary still shows them (simulation D5)', async () => {
    const { principal } = await newOwner();
    const restrictionId = (await getStyleContext(db(), principal, '2026-10-07')).restrictions[0]!.restrictionId;
    const words = 'My feet have fully healed now, so I can wear my welted shoes and boots again.';
    const evidence = `Owner, mcp: "${words}"`; // the form the assistant's lift tool records
    const lifted = await ok(principal, { type: 'lift_restriction', restrictionId, evidence }, { source: 'mcp' });
    expect(lifted.summary.startsWith(`Restriction lifted on the owner's words (mcp): \u201c${words}\u201d. Was: `)).toBe(true);
    // The simulation report cuts each summary at 200 characters.
    expect(lifted.summary.slice(0, 200)).toContain(words);
    expect(lifted.facts.evidence).toBe(evidence);
    const row = await db().prepare('SELECT lift_evidence FROM restrictions WHERE user_id = ? AND restriction_id = ?').bind(principal.userId, restrictionId).first<{ lift_evidence: string }>();
    expect(row!.lift_evidence).toBe(evidence);
    // The healing rule itself is unchanged: a quoted or third-person statement still does not lift it.
    await ok(principal, { type: 'undo', targetCommandId: lifted.commandId });
    for (const bad of ['Owner, mcp: "The physio said my feet have healed."', 'Owner, mcp: "Your feet have healed."']) {
      expect((await run(principal, { type: 'lift_restriction', restrictionId, evidence: bad }, { source: 'mcp' })).error?.code, bad).toBe('evidence_required');
    }
  });
});
