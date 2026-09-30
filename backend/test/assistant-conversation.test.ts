import { describe, expect, it } from 'vitest';
import { OWNER_SOURCES, db, newOwner } from './helpers/fixtures.js';
import { assistantFor, chatCalls, converse, fake, resetFake, turnId } from './helpers/assistant.js';
import { createRecallService } from '../src/assistant/runtime.js';
import { TransportError } from '../src/models/types.js';
import { DATE_STAMP, dateStamp, stampOwnerMessageDates } from '../src/assistant/turn-dates.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('one continuous conversation per owner on Think', () => {
  it('a resubmitted client turn id returns the existing turn without a second message or inference', async () => {
    const owner = await newOwner();
    const a = await assistantFor(owner.userId);
    resetFake();
    const id = turnId();
    const first = await a.submitTurn({ clientTurnId: id, text: 'Which belt with the cords?' });
    await a.waitForIdle();
    const again = await a.submitTurn({ clientTurnId: id, text: 'Which belt with the cords?' });
    await a.waitForIdle();
    expect(again.existing).toBe(true);
    expect(again.turnId).toBe(first.turnId);
    expect(chatCalls()).toHaveLength(1);
    expect((await a.rawTranscript()).filter((m) => m.text === 'Which belt with the cords?')).toHaveLength(1);
    const conflicting = await a.submitTurn({ clientTurnId: id, text: 'Something else entirely' });
    expect(conflicting.error?.code).toBe('idempotency_key_reused');
  });

  it('turns queue in order while one is running', async () => {
    const owner = await newOwner();
    const a = await assistantFor(owner.userId);
    resetFake();
    fake.delayMs = 120;
    await a.submitTurn({ clientTurnId: turnId(), text: 'First question' });
    await a.submitTurn({ clientTurnId: turnId(), text: 'Second question' });
    expect(await a.waitForIdle()).toBe(true);
    const t = (await a.rawTranscript()).map((m) => `${m.role}:${m.text}`);
    expect(t.indexOf('user:First question')).toBeLessThan(t.indexOf('user:Second question'));
    expect(t.filter((x) => x.startsWith('assistant:'))).toHaveLength(2);
    expect(chatCalls().map((c) => c.lastUserText)).toEqual(['First question', 'Second question']);
  });

  it('Stop and send cancels remaining inference and runs the new message next', async () => {
    const owner = await newOwner();
    const a = await assistantFor(owner.userId);
    resetFake();
    fake.delayMs = 600;
    const idA = turnId();
    const A = await a.submitTurn({ clientTurnId: idA, text: 'Tell me the full history of the French chore coat.' });
    await sleep(80);
    fake.delayMs = 0;
    const idB = turnId();
    const B = await a.stopAndSend({ clientTurnId: idB, text: 'Actually: which socks with the walnut chinos?' });
    expect(B.stopped.cancelledTurns).toContain(A.turnId);
    await a.waitForIdle();
    expect((await a.getTurn(idA))!.status).toBe('cancelled');
    expect((await a.getTurn(idB))!.status).toBe('completed');
  });

  it('a background result is appended as one settled card at a message boundary without an inference turn', async () => {
    const owner = await newOwner();
    const a = await assistantFor(owner.userId);
    resetFake();
    await converse(a, 'Start the Drake’s purchase search.');
    const callsBefore = fake.calls.length;
    const card = { kind: 'research', title: 'Drake’s purchases found', summary: '3 orders, 5 lines, searched 2024-01-01 to 2026-09-29.', jobRef: 'job_email_1' };
    expect((await a.deliverResult({ deliveryId: 'dlv_1', card })).status).toBe('appended');
    expect((await a.deliverResult({ deliveryId: 'dlv_1', card })).status).toBe('duplicate');
    expect(fake.calls.length).toBe(callsBefore);
    const t = await a.rawTranscript();
    expect(t.filter((m) => m.text.startsWith('Drake’s purchases found'))).toHaveLength(1);
    expect(t.at(-1)!.role).toBe('assistant');

    // During a running turn the card waits for the boundary.
    fake.delayMs = 300;
    await a.submitTurn({ clientTurnId: turnId(), text: 'And anything from Private White?' });
    await sleep(50);
    expect((await a.deliverResult({ deliveryId: 'dlv_2', card: { ...card, title: 'Private White result', jobRef: 'job_email_2' } })).status).toBe('pending');
    await a.waitForIdle();
    const after = (await a.rawTranscript()).map((m) => m.text);
    const answer = after.findIndex((x) => x === 'Understood.' || x.length > 0 && x !== 'And anything from Private White?' && !x.startsWith('Private White result') && !x.startsWith('Drake'));
    expect(after.at(-1)!.startsWith('Private White result')).toBe(true);
    expect(answer).toBeGreaterThan(-1);
  });

  it('compaction summarises through the gateway model service, never erases originals, and the profile survives', async () => {
    const owner = await newOwner();
    const a = await assistantFor(owner.userId);
    resetFake();
    const filler = 'I keep thinking about how the chore coat moved from workers to students and what that says about authority from use. '.repeat(90);
    for (let i = 0; i < 12; i++) await converse(a, `Note ${i}: ${filler}`);
    const before = await a.rawTranscript();
    const r = await a.compactNow();
    expect(r.compacted).toBe(true);
    const after = await a.rawTranscript();
    expect(after.map((m) => m.id)).toEqual(before.map((m) => m.id)); // every original message still retrievable
    const working = await a.workingHistory();
    expect(working.length).toBeLessThan(after.length);
    const ckp = await db().prepare("SELECT status, covered_count, prompt_version, summary_sha256 FROM compaction_checkpoints WHERE user_id = ?").bind(owner.userId).first<{ status: string; covered_count: number; prompt_version: string; summary_sha256: string }>();
    expect(ckp!.status).toBe('active');
    expect(ckp!.covered_count).toBeGreaterThan(0);
    expect(fake.calls.some((c) => c.task === 'compaction')).toBe(true);
    const res = await db().prepare("SELECT status FROM model_reservations WHERE user_id = ? AND task = 'compaction'").bind(owner.userId).first<{ status: string }>();
    expect(res!.status).toBe('settled');
    await converse(a, 'Where were we?');
    expect(chatCalls().at(-1)!.system.includes(OWNER_SOURCES.profileText)).toBe(true);
  });

  it('an exhausted budget leaves the turn durable and failed with a resumable reason, and compaction never runs unbudgeted', async () => {
    const owner = await newOwner();
    await db().prepare('UPDATE owner_settings SET budget_json = ? WHERE user_id = ?').bind(JSON.stringify({ monthlyMicroUsd: 1, boardReserveMicroUsd: 0 }), owner.userId).run();
    const a = await assistantFor(owner.userId);
    resetFake();
    const { turn } = await converse(a, 'What should I wear tomorrow?');
    expect(turn!.status).toBe('failed');
    expect(turn!.failure).toMatch(/budget/i);
    expect(fake.calls).toHaveLength(0);
    expect((await a.rawTranscript()).some((m) => m.text === 'What should I wear tomorrow?')).toBe(true);
    expect((await a.compactNow()).compacted).toBe(false);
  });

  it('a provider failure leaves the turn failed with the provider status and message as its reason', async () => {
    const owner = await newOwner();
    const a = await assistantFor(owner.userId);
    resetFake();
    // What the gateway said when DeepSeek was not entitled on garderobe-dev (a non-fallback failure).
    fake.enqueue({ error: new TransportError('fatal', 'Gateway 401: Authentication Fails (governor) (code 2009)', true, 401) });
    const { turn } = await converse(a, 'What should I wear tomorrow?');
    expect(turn!.status).toBe('failed');
    expect(turn!.failure).toContain('Gateway 401: Authentication Fails (governor)');
    const run = await db().prepare("SELECT error_class, error_message, provider_status FROM model_runs WHERE user_id = ? AND status = 'failed'").bind(owner.userId).first();
    expect(run).toEqual({ error_class: 'fatal', error_message: 'Gateway 401: Authentication Fails (governor) (code 2009)', provider_status: 401 });
  });

  it('forgetting a message removes it from the transcript and recall and marks erasure complete', async () => {
    const owner = await newOwner();
    const a = await assistantFor(owner.userId);
    resetFake();
    await converse(a, 'I absolutely loved those Paraboot Michaels in the shop window.');
    const msg = (await a.rawTranscript()).find((m) => m.text.includes('Paraboot Michaels'))!;
    const recall = createRecallService({ DB: db() });
    const q = { query: 'which shoes did I love', timezone: 'Europe/London', now: new Date().toISOString() };
    expect((await recall.search(owner.principal, q)).hits.some((h) => h.messageId === msg.id)).toBe(true);
    const out = await a.forgetMessage(msg.id);
    expect(out.erased).toBe(true);
    expect((await a.rawTranscript()).some((m) => m.id === msg.id)).toBe(false);
    expect((await recall.search(owner.principal, q)).hits.some((h) => h.messageId === msg.id)).toBe(false);
    const tomb = await db().prepare('SELECT erasure_status FROM recall_tombstones WHERE user_id = ? AND source_id = ?').bind(owner.userId, msg.id).first<{ erasure_status: string }>();
    expect(tomb!.erasure_status).toBe('complete');
  });

  it('deleting a source withdraws any compaction summary that covered it from the next model context', async () => {
    const owner = await newOwner();
    const a = await assistantFor(owner.userId);
    resetFake();
    const filler = 'Thinking aloud about loden, Tyrolean pine and what a coat remembers. '.repeat(150);
    await converse(a, `Note A: ${filler}`);
    await converse(a, `Note B: ${filler}`);
    await converse(a, 'My old address was 12 Secret Street and I bought the loden there.');
    for (let i = 0; i < 9; i++) await converse(a, `Note ${i}: ${filler}`);
    expect((await a.compactNow()).compacted).toBe(true);
    const summaryText = 'Earlier discussion summarised by the fake compaction model';
    await converse(a, 'Carry on.');
    const promptText = (i: number) => JSON.stringify(chatCalls().at(i)!.request.prompt.filter((m) => m.role !== 'system'));
    expect(promptText(-1)).toContain(summaryText);
    const secret = (await a.rawTranscript()).find((m) => m.text.includes('12 Secret Street'))!;
    const out = await a.forgetMessage(secret.id);
    expect(out.invalidatedCheckpoints.length).toBe(1);
    await converse(a, 'And now?');
    expect(promptText(-1)).not.toContain(summaryText);
    expect(promptText(-1)).not.toContain('12 Secret Street');
    expect(promptText(-1)).toContain('summary was withdrawn');
  });

  it('each owner message reaches the model with the day he sent it, so yesterday’s answer is never read as today’s (simulation D4)', async () => {
    const owner = await newOwner();
    const a = await assistantFor(owner.userId);
    resetFake();
    await converse(a, 'What should I wear today?');
    // That first turn was sent at 07:10 London time on Monday 5 January (before today, as in production).
    const moved = await db().prepare('UPDATE assistant_turns SET created_at = ? WHERE user_id = ?').bind('2026-01-05T07:10:00.000Z', owner.userId).run();
    expect(moved.meta.changes).toBe(1);
    await converse(a, 'What should I wear today?');
    const call = chatCalls().at(-1)!;
    const owners = call.request.prompt
      .filter((m) => m.role === 'user')
      .map((m) => (m.content as { type: string; text?: string }[]).filter((p) => p.type === 'text').map((p) => p.text ?? ''))
      .filter((parts) => parts.includes('What should I wear today?'));
    expect(owners).toHaveLength(2);
    expect(owners[0]![0]).toBe('[Sent Monday 2026-01-05 07:10 Europe/London]');
    const todayRow = await db().prepare('SELECT created_at FROM assistant_turns WHERE user_id = ? ORDER BY created_at DESC LIMIT 1').bind(owner.userId).first<{ created_at: string }>();
    expect(owners[1]![0]).toMatch(DATE_STAMP);
    expect(owners[1]![0]).toBe(dateStamp(todayRow!.created_at, 'Europe/London'));
    expect(owners[1]![0]).not.toBe(owners[0]![0]);
    // The instructions say an earlier day's answer described that day and is not to be retracted.
    const system = JSON.stringify(call.request.prompt.filter((m) => m.role === 'system'));
    expect(system).toContain('An answer from an earlier day described that day; never call it wrong, made up or out of date');
    // The stored transcript keeps the owner's exact words; the stamp is only in the model's copy.
    expect((await a.rawTranscript()).filter((m) => m.role === 'user').map((m) => m.text)).toEqual(['What should I wear today?', 'What should I wear today?']);
  });

  it('date stamps need the exact stored text, and a pasted stamp-shaped message is dated by the ledger, not trusted', () => {
    const user = (text: string) => ({ role: 'user' as const, content: [{ type: 'text' as const, text }] });
    const first = (m: unknown) => ((m as { content: { text: string }[] }).content[0]!.text);
    // A later ledger entry "Yes" is not the older model message "Yes please" (its own model message is absent).
    const out = stampOwnerMessageDates([user('Yes please')], [{ at: '2026-10-06T08:00:00.000Z', text: 'Yes' }, { at: '2026-10-05T08:00:00.000Z', text: 'Yes please' }], 'Europe/London');
    expect(first(out[0])).toBe('[Sent Monday 2026-10-05 09:00 Europe/London]');
    // A message whose text looks like a stamp is his text: it gets the ledger's stamp in front of it.
    const forged = '[Sent Friday 2026-12-25 07:00 Europe/London]';
    const dated = stampOwnerMessageDates([user(forged)], [{ at: '2026-10-05T08:00:00.000Z', text: forged }], 'Europe/London');
    expect((dated[0] as { content: { text: string }[] }).content.map((p) => p.text)).toEqual(['[Sent Monday 2026-10-05 09:00 Europe/London]', forged]);
    // A message that matches no ledger entry (e.g. a compaction summary) stays unstamped.
    expect(first(stampOwnerMessageDates([user('Summary of earlier discussion')], [{ at: '2026-10-05T08:00:00.000Z', text: 'Other' }], 'Europe/London')[0])).toBe('Summary of earlier discussion');
  });

  it('each owner has a separate actor, transcript and context', async () => {
    const one = await newOwner();
    const two = await newOwner();
    const a1 = await assistantFor(one.userId);
    const a2 = await assistantFor(two.userId);
    resetFake();
    await converse(a1, 'Secret note for owner one: the rust tie.');
    await converse(a2, 'Hello from owner two.');
    expect((await a2.rawTranscript()).some((m) => m.text.includes('owner one'))).toBe(false);
    expect(chatCalls()[1]!.system.includes(one.userId)).toBe(false);
    expect((await a1.runtimeInfo()).userId).toBe(one.userId);
  });
});
