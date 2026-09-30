import { describe, expect, it } from 'vitest';
import { db, newUser } from './helpers/fixtures.js';
import { LocalSearchIndex, RecallService, extractJudgments, resolveDateRange } from '../src/recall/index.js';

const TZ = 'Europe/London';
const NOW = '2026-09-28T09:00:00.000Z';

async function seed(userId: string, index: LocalSearchIndex) {
  const recall = new RecallService(db(), index);
  const msgs = [
    { messageId: 'm_june', role: 'user' as const, text: 'Not sure about loafers yet.', authoredAt: '2026-06-20T10:00:00.000Z' },
    { messageId: 'm_july_1', role: 'user' as const, text: 'Tried the Paraboot Avignon in the shop today and honestly I adore them, the Norwegian welt is gorgeous.', authoredAt: '2026-07-14T15:00:00.000Z' },
    { messageId: 'm_july_2', role: 'assistant' as const, text: 'I would suggest the Paraboot Chambord as an alternative worth a look.', authoredAt: '2026-07-14T15:01:00.000Z' },
    { messageId: 'm_july_3', role: 'user' as const, text: 'The navy chinos were fine.', authoredAt: '2026-07-20T09:00:00.000Z' },
    { messageId: 'm_aug', role: 'user' as const, text: 'Returned the Avignon, sent them back because they were too small in UK 8.', authoredAt: '2026-08-10T12:00:00.000Z' },
  ];
  await recall.project(userId, msgs);
  return recall;
}

describe('recall: source-grounded, dated, watermarked', () => {
  it('resolves “last July” from a September conversation to July of the same year, and flags a genuinely ambiguous month', () => {
    expect(resolveDateRange('What shoes did I like so much last July?', NOW, TZ)).toMatchObject({ from: '2026-07-01', to: '2026-07-31', ambiguous: null });
    expect(resolveDateRange('the jacket from last month', NOW, TZ)).toMatchObject({ from: '2026-08-01', to: '2026-08-31' });
    expect(resolveDateRange('in October', NOW, TZ)).toMatchObject({ from: '2025-10-01', to: '2025-10-31' });
    expect(resolveDateRange('in September', NOW, TZ)!.ambiguous).toMatch(/could mean/);
  });

  it('finds a July liking through a paraphrase with the owner’s words, date and link; the assistant’s suggestion and the later return stay distinct', async () => {
    const u = await newUser();
    const index = new LocalSearchIndex(db());
    const recall = await seed(u.userId, index);
    await recall.catchUp(u.userId);
    const r = await recall.search(u, { query: 'What shoes did I like so much last July?', timezone: TZ, now: NOW });
    expect(r.range).toMatchObject({ from: '2026-07-01', to: '2026-07-31' });
    expect(r.hits[0]!.messageId).toBe('m_july_1');
    expect(r.hits[0]!.speaker).toBe('owner');
    expect(r.hits[0]!.quote).toContain('I adore them');
    expect(r.hits[0]!.localDate).toBe('2026-07-14');
    expect(r.hits[0]!.link).toBe('garderobe://conversation/m_july_1');
    expect(r.hits[0]!.context.after).toContain('Chambord');
    expect(r.hits.find((h) => h.messageId === 'm_july_2')?.judgments.every((j) => j.speaker === 'assistant') ?? true).toBe(true);
    expect(r.laterReversals.map((x) => x.messageId)).toContain('m_aug');
    expect(r.coverage.exhaustive).toBe(true);
    expect(r.notes.join(' ')).toMatch(/does not imply ownership/);
  });

  it('catches up from its watermark after an index outage without losing or duplicating, and says when results are not exhaustive', async () => {
    const u = await newUser();
    const index = new LocalSearchIndex(db());
    const recall = await seed(u.userId, index);
    index.failAfter = 2;
    await expect(recall.catchUp(u.userId)).rejects.toThrow(/outage/);
    const w1 = await db().prepare('SELECT indexed_seq FROM recall_watermarks WHERE user_id = ?').bind(u.userId).first<{ indexed_seq: number }>();
    expect(w1!.indexed_seq).toBe(2);
    const partial = await recall.search(u, { query: 'what shoes did I love last July', timezone: TZ, now: NOW });
    expect(partial.coverage.exhaustive).toBe(false);
    expect(partial.notes.join(' ')).toMatch(/not be exhaustive/);
    expect(partial.hits[0]!.messageId).toBe('m_july_1'); // unindexed rows are read from the source
    index.failAfter = null;
    await recall.catchUp(u.userId);
    const docs = await db().prepare('SELECT COUNT(*) AS n FROM recall_index_docs WHERE user_id = ?').bind(u.userId).first<{ n: number }>();
    expect(docs!.n).toBe(5);
    expect((await recall.search(u, { query: 'shoes I loved last July', timezone: TZ, now: NOW })).coverage.exhaustive).toBe(true);
  });

  it('an accepted but still-pending upload does not advance coverage', async () => {
    const u = await newUser();
    const index = new LocalSearchIndex(db());
    const recall = await seed(u.userId, index);
    index.holdPending = true;
    const r = await recall.catchUp(u.userId);
    expect(r.uploaded).toBe(5);
    expect(r.indexedSeq).toBe(0);
  });

  it('a deleted source never reappears, even when the stale index still returns it', async () => {
    const u = await newUser();
    const index = new LocalSearchIndex(db());
    const recall = await seed(u.userId, index);
    await recall.catchUp(u.userId);
    // Simulate a stale index: forget, then put the document back into the index behind the service's back.
    await recall.forget(u.userId, 'm_july_1', 'owner request');
    await index.upload(u.userId, [{ sourceId: 'm_july_1', revision: 1, kind: 'conversation', occurredAt: '2026-07-14T15:00:00.000Z', body: 'owner: I adore the Paraboot Avignon shoes' }]);
    const r = await recall.search(u, { query: 'What shoes did I like so much last July?', timezone: TZ, now: NOW });
    expect(r.hits.some((h) => h.messageId === 'm_july_1')).toBe(false);
    // Re-projection from a restored backup cannot resurrect it either.
    expect(await recall.project(u.userId, [{ messageId: 'm_july_1', role: 'user', text: 'I adore them', authoredAt: '2026-07-14T15:00:00.000Z' }])).toBe(0);
  });

  it('judgments keep speaker, flip negated likings and ignore questions', () => {
    expect(extractJudgments('I love the Reims in black.', 'owner')[0]).toMatchObject({ kind: 'liked', speaker: 'owner' });
    expect(extractJudgments("I don't love these sneakers.", 'owner')[0]!.kind).toBe('rejected');
    expect(extractJudgments('Do you love these shoes?', 'owner')).toHaveLength(0);
    expect(extractJudgments('I would recommend the Michael.', 'assistant')[0]).toMatchObject({ kind: 'recommended', speaker: 'assistant' });
  });

  it('isolates owners: one owner’s recall never returns another’s messages', async () => {
    const a = await newUser();
    const b = await newUser();
    const index = new LocalSearchIndex(db());
    await seed(a.userId, index);
    const recall = new RecallService(db(), index);
    await recall.catchUp(a.userId);
    const r = await recall.search(b, { query: 'What shoes did I like so much last July?', timezone: TZ, now: NOW });
    expect(r.hits).toHaveLength(0);
  });
});
