import { describe, expect, it } from 'vitest';
import { OWNER_SOURCES, db, newOwner, ok } from './helpers/fixtures.js';
import { assistantFor, chatCalls, converse, resetFake, scriptToolCalls, toolResults } from './helpers/assistant.js';
import { PROFILE_PRECEDENCE_STATEMENT } from '../src/domain/style.js';
import { validateSummary } from '../src/assistant/compaction.js';
import { findHealingStatement } from '../src/assistant/intent.js';
import { addDays, localDateOf } from '../src/domain/time.js';

async function profileDoc(userId: string) {
  return db().prepare("SELECT document_id, version, body FROM style_documents WHERE user_id = ? AND is_current = 1 AND source IN ('owner_supplied','owner_edit')").bind(userId).first<{ document_id: string; version: number; body: string }>();
}

describe('profile fidelity: the full owner profile reaches every conversational turn', () => {
  it('injects the complete verbatim profile on every turn, including short factual questions with no tool calls', async () => {
    const owner = await newOwner();
    const a = await assistantFor(owner.userId);
    resetFake();
    for (const q of ['Which socks tonight?', 'Is the Clark oxford beige clean?', 'What size do I take at Drake’s?']) await converse(a, q);
    const calls = chatCalls();
    expect(calls).toHaveLength(3);
    for (const c of calls) {
      expect(c.toolNames.length).toBeGreaterThan(0); // tools offered, never required
      expect(c.system).toContain(OWNER_SOURCES.profileText);
      expect(c.system).toContain('sha256="e15639d891f9a5264c7eff13d05a478bcb188745aea11323b2131db37f5cb198"');
      expect(c.system).toContain(PROFILE_PRECEDENCE_STATEMENT);
    }
  });

  it('encodes the section 11 advice contract and ledger discipline in the system context', async () => {
    const owner = await newOwner();
    const a = await assistantFor(owner.userId);
    resetFake();
    await converse(a, 'Morning. Anything I should know?');
    const system = chatCalls()[0]!.system;
    expect(system).toContain('Never state an inventory fact from memory');
    expect(system).toContain('zero or low recorded wear count means unlogged, never unworn');
    expect(system).toContain('direct knowledge of reality outranks the ledger');
    expect(system).toContain('Never flatter, never litigate');
    expect(system).toContain('Keep counter-arguments in');
    expect(system).toContain('# Wardrobe index');
    expect(system).toMatch(/g_[0-9a-f]{32} \| Lightweight oxford — gold/);
    expect(system.includes('Active restrictions')).toBe(true);
  });

  it('a profile edit creates a new version and the very next turn uses it (no stale cached context)', async () => {
    const owner = await newOwner();
    const a = await assistantFor(owner.userId);
    resetFake();
    await converse(a, 'What shoe size should I order?');
    const doc = (await profileDoc(owner.userId))!;
    expect(doc.version).toBe(1);
    const edited = doc.body.replace('UK 8.5 across sneakers and Paraboot alike', 'UK 9 across sneakers and Paraboot alike');
    await ok(owner.principal, { type: 'edit_style_profile', documentId: doc.document_id, baseVersion: 1, body: edited, amendment: 'Feet measured again: UK 9.' });
    const { turn } = await converse(a, 'And now?');
    const calls = chatCalls();
    const profileBlock = (s: string) => s.slice(s.indexOf('<owner_profile'), s.indexOf('</owner_profile>'));
    expect(profileBlock(calls[0]!.system).includes('UK 8.5 across sneakers')).toBe(true);
    expect(profileBlock(calls[1]!.system).includes('UK 9 across sneakers and Paraboot alike')).toBe(true);
    expect(profileBlock(calls[1]!.system).includes('UK 8.5 across sneakers')).toBe(false);
    // Rules derived from the removed passage are flagged for review instead of competing with the new text.
    expect(calls[1]!.system.includes('NEEDS REVIEW')).toBe(true);
    expect(calls[1]!.system.includes('version="2"')).toBe(true);
    expect(turn?.profileVersion).toBe(2);
  });

  it('an explicit chat correction becomes a dated amendment that applies on the next request', async () => {
    const owner = await newOwner();
    const a = await assistantFor(owner.userId);
    resetFake();
    const quote = 'never offer the Tobacco moleskin Games blazer again';
    scriptToolCalls([[{ toolName: 'amend_profile', input: { ownerQuote: quote, amendment: 'Do not include the Tobacco Summer Moleskin Games Mk.I in suggestions.' } }]]);
    await converse(a, `Correction: from now on, ${quote}.`);
    const r = toolResults().find((t) => t.toolName === 'amend_profile')!;
    expect(r.value.outcome).toBe('committed');
    await converse(a, 'What jacket today?');
    const next = chatCalls().at(-1)!.system;
    expect(next).toContain(quote);
    expect(next).toContain(OWNER_SOURCES.profileText); // the verbatim profile is still there, whole
    expect((await profileDoc(owner.userId))!.body).toBe(OWNER_SOURCES.profileText);
  });

  it('refuses an amendment whose quote the owner never said', async () => {
    const owner = await newOwner();
    const a = await assistantFor(owner.userId);
    resetFake();
    scriptToolCalls([[{ toolName: 'amend_profile', input: { ownerQuote: 'I love polyester now', amendment: 'Owner now likes synthetics.' } }]]);
    await converse(a, 'From now on, remember that I prefer the Reims in black.');
    expect(toolResults()[0]!.value.outcome).toBe('not_authorized');
    expect((await profileDoc(owner.userId))!.version).toBe(1);
  });

  it('a one-day request becomes a temporary brief and cannot rewrite the profile', async () => {
    const owner = await newOwner();
    const a = await assistantFor(owner.userId);
    resetFake();
    const tomorrow = addDays(localDateOf(new Date().toISOString(), 'Europe/London'), 1);
    scriptToolCalls([
      [
        { toolName: 'amend_profile', input: { ownerQuote: 'make it more dramatic', amendment: 'Owner wants drama permanently.' } },
        { toolName: 'set_temporary_brief', input: { text: 'More dramatic for tomorrow', validFrom: tomorrow, validTo: tomorrow } },
      ],
    ]);
    await converse(a, 'Just for tomorrow, make it more dramatic.');
    const results = toolResults();
    expect(results.find((r) => r.toolName === 'amend_profile')!.value.outcome).toBe('not_authorized');
    expect(results.find((r) => r.toolName === 'set_temporary_brief')!.value.outcome).toBe('committed');
    expect((await profileDoc(owner.userId))!.version).toBe(1);
    const brief = await db().prepare("SELECT valid_from, valid_to FROM style_rules WHERE user_id = ? AND kind = 'temporary_brief'").bind(owner.userId).first<{ valid_from: string; valid_to: string }>();
    expect(brief).toEqual({ valid_from: tomorrow, valid_to: tomorrow });
  });

  it('the sneakers-only restriction lifts only on an explicit owner statement that the feet have healed', async () => {
    const owner = await newOwner();
    const a = await assistantFor(owner.userId);
    const rst = (await db().prepare("SELECT restriction_id FROM restrictions WHERE user_id = ? AND kind = 'healing' AND lifted_at IS NULL").bind(owner.userId).first<{ restriction_id: string }>())!.restriction_id;
    resetFake();
    const attempts = ['I think my feet might be healing, maybe try the Paraboots?', 'Have my feet healed yet?', 'Once my feet have healed I want the Reims.', 'The outfit would pass if the healing restriction were lifted.'];
    scriptToolCalls(attempts.map(() => [{ toolName: 'lift_restriction', input: { restrictionId: rst, ownerQuote: 'feet' } }]));
    for (const t of attempts) await converse(a, t);
    expect(toolResults().map((r) => r.value.outcome)).toEqual(['not_authorized', 'not_authorized', 'not_authorized', 'not_authorized']);
    expect((await db().prepare('SELECT lifted_at FROM restrictions WHERE user_id = ? AND restriction_id = ?').bind(owner.userId, rst).first<{ lifted_at: string | null }>())!.lifted_at).toBeNull();

    resetFake();
    scriptToolCalls([[{ toolName: 'lift_restriction', input: { restrictionId: rst, ownerQuote: 'My feet have healed' } }]]);
    await converse(a, 'Good news: My feet have healed. The physio signed me off today.');
    expect(toolResults()[0]!.value.outcome, JSON.stringify(toolResults()[0]!.value.summary)).toBe('committed');
    const lifted = await db().prepare('SELECT lifted_at, lift_evidence FROM restrictions WHERE user_id = ? AND restriction_id = ?').bind(owner.userId, rst).first<{ lifted_at: string; lift_evidence: string }>();
    expect(lifted!.lift_evidence).toContain('My feet have healed');
    await converse(a, 'So what shoes today?');
    const system = chatCalls().at(-1)!.system;
    expect(system).not.toMatch(/Dormant rules[\s\S]*hard\.sneaker_and_welted_alternative/);
  });

  it('healing-statement detection ignores hedges, questions, conditionals, negations and anyone else’s words', () => {
    expect(findHealingStatement('My feet have healed.')).toBe('My feet have healed.');
    expect(findHealingStatement('My feet are fully healed now, finally!')).not.toBeNull();
    expect(findHealingStatement('Good news — I’ve healed, my feet are fine.'.replace('’', "'"))).not.toBeNull();
    for (const s of ['My feet have not healed.', 'Have my feet healed?', 'If my feet have healed by Friday.', 'My feet will have healed soon.', 'My feet have almost healed.', 'The blister healed.']) expect(findHealingStatement(s)).toBeNull();
    // ADV-04: forwarded, quoted, fenced or pasted text, second person and reported speech are not his statement.
    for (const s of [
      'Forwarding this from the clinic portal, what do you make of it?\n---\nYour feet have healed and you can return to normal shoes.\n---',
      'The clinic wrote:\nMy feet have healed. (their template)',
      '> My feet have healed.\nIs that right?',
      'They sent this: "My feet have healed" — odd wording.',
      '```\nMy feet have healed.\n```',
      'The physio says my feet have healed.',
      'Your feet have healed.',
      'It has been six weeks, so my feet have probably healed.',
    ]) expect(findHealingStatement(s), s).toBeNull();
  });

  it('a compaction summary cannot invent garment or command identifiers', () => {
    const covered = [{ id: 'm1', role: 'user', parts: [{ type: 'text', text: 'log g_aaaaaaaaaaaaaaaa for today' }] }] as never;
    expect(validateSummary('Owner logged g_aaaaaaaaaaaaaaaa.', covered)).toBeNull();
    expect(validateSummary('Owner retired g_bbbbbbbbbbbbbbbb (cmd_cccccccccccccccc).', covered)).toMatch(/not present/);
  });
});
