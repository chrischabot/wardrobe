import { describe, expect, it } from 'vitest';
import { runInDurableObject } from 'cloudflare:test';
import { ConversationPage, RunStatus, TurnResponse } from '@garderobe/contracts';
import { db, newOwner, OWNER_SOURCES } from './helpers/fixtures.js';
import { assistantFor, chatCalls, converse, fake, resetFake, turnId } from './helpers/assistant.js';
import { apiOwner, callJson, installApiScenario } from './helpers/api.js';
import { issueRecoveryCredential } from '../src/lifecycle/recovery.js';
import { exportOwnerData, verifyExport } from '../src/export/index.js';
import { redactPastedSecrets } from '../src/assistant/secrets.js';

/** Every D1 table whose rows contain the needle. */
async function d1Hits(needle: string): Promise<string[]> {
  const { results } = await db().prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name NOT LIKE 'd1_%'").all<{ name: string }>();
  const hits: string[] = [];
  for (const { name } of results) {
    const rows = await db().prepare(`SELECT * FROM "${name}"`).all();
    if (JSON.stringify(rows.results).includes(needle)) hits.push(name);
  }
  return hits;
}

/** Every table of the assistant actor's own SQLite store (Think Session, submissions, compaction) holding the needle. */
async function actorStoreHits(stub: unknown, needle: string): Promise<string[]> {
  return runInDurableObject(stub as DurableObjectStub, (_instance, state) => {
    const tables = state.storage.sql.exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'").toArray();
    const hits: string[] = [];
    for (const { name } of tables) if (JSON.stringify(state.storage.sql.exec(`SELECT * FROM "${name}"`).toArray()).includes(needle)) hits.push(name);
    return hits;
  });
}

describe('pasted secrets in the conversation (ADV-17)', () => {
  it('[ADV-17] a pasted recovery code is removed before the turn is stored, projected, indexed, sent to a model or exported, and the owner is told', async () => {
    const owner = await newOwner();
    const kit = await issueRecoveryCredential(db(), owner.userId);
    const secret = kit.credential.split('.')[2]!;
    const a = await assistantFor(owner.userId);
    resetFake();
    const clientTurnId = turnId();
    const text = `Please remember this for me: ${kit.credential}`;
    const receipt = await a.submitTurn({ clientTurnId, text } as never);
    await a.waitForIdle();
    expect(receipt.redacted).toEqual([{ kind: 'recovery_code', count: 1 }]);
    // A resubmitted turn is still the same turn.
    expect((await a.submitTurn({ clientTurnId, text } as never)).existing).toBe(true);
    // The next turn's model context is built from the stored history.
    await converse(a, 'What did I ask you to remember?');
    expect(chatCalls().length).toBeGreaterThanOrEqual(2);
    expect(JSON.stringify(fake.calls)).not.toContain(secret);

    const transcript = await a.rawTranscript();
    const mine = transcript.find((m) => m.role === 'user' && m.text.startsWith('Please remember this for me:'))!;
    expect(mine.text).toBe('Please remember this for me: [recovery code removed]');
    const note = transcript.find((m) => (m.metadata as { kind?: string } | null)?.kind === 'result_card');
    expect(note?.text).toContain('Recovery code removed from your message');
    expect(transcript.indexOf(note!)).toBeGreaterThan(transcript.indexOf(mine));

    // Positive controls: the scans do read the stores that hold this conversation.
    expect(await d1Hits('Please remember this for me')).toEqual(expect.arrayContaining(['assistant_turns', 'recall_messages']));
    expect((await actorStoreHits(a, 'Please remember this for me')).length).toBeGreaterThan(0);
    expect(await d1Hits(secret)).toEqual([]);
    expect(await actorStoreHits(a, secret)).toEqual([]);
    const pkg = await exportOwnerData(db(), owner.principal, { transcript: transcript.map((m) => ({ id: m.id, role: m.role, text: m.text })) });
    expect(JSON.stringify(pkg)).not.toContain(secret);
    expect(pkg.files['conversation/messages.json']).toContain('[recovery code removed]');
  });

  it('[ADV-17] the export also removes codes kept in rows and transcripts from before turns were redacted', async () => {
    const owner = await newOwner();
    const kit = await issueRecoveryCredential(db(), owner.userId);
    const secret = kit.credential.split('.')[2]!;
    await db()
      .prepare("INSERT INTO recall_messages (user_id, message_id, seq, conversation_id, role, speaker, authored_at, text, terms, entity_ids_json, revision) VALUES (?, 'msg_legacy_0001', 1, 'main', 'user', 'owner', '2026-09-01T08:00:00.000Z', ?, '', '[]', 1)")
      .bind(owner.userId, `my code is ${kit.credential}`)
      .run();
    const pkg = await exportOwnerData(db(), owner.principal, { transcript: [{ id: 'msg_legacy_0001', role: 'user', text: `my code is ${kit.credential}` }] });
    expect(JSON.stringify(pkg)).not.toContain(secret);
    expect(JSON.parse(pkg.files['data/recall_messages.json']!)[0].text).toBe('my code is [recovery code removed]');
    expect((await verifyExport(pkg)).ok).toBe(true);
  });

  it('removes credential shapes but leaves garment text, maker codes, sizes, links and ids untouched', async () => {
    const kit = await issueRecoveryCredential(db(), (await newOwner()).userId);
    const [, id, secret] = kit.credential.split('.');
    const removed: [string, string][] = [
      [kit.credential, '[recovery code removed]'],
      [`grdb ${id} ${secret!.toLowerCase()}`, '[recovery code removed]'],
      [secret!, '[recovery code removed]'],
      ['https://garderobe.example/v1/export/downloads/xfr_0123abcd?t=eyJrIjoiZXhwb3J0In0.c2lnbmF0dXJl', 'https://garderobe.example/v1/export/downloads/xfr_0123abcd?t=[removed]'],
      ['/v1/auth/recovery-kit/collect/xfr_9f?t=abc.def', '/v1/auth/recovery-kit/collect/xfr_9f?t=[removed]'],
      ['Authorization: Bearer 3kF9qLzP0aXw7Rt2Yb8NcVd', 'Authorization: Bearer [secret removed]'],
      ['token Zk3pQ9x-L2mW7_aT4nR8vB1cY6dE0fGhJ5sU3oIq2wA', 'token [secret removed]'],
      ['key sk-proj-A1b2C3d4E5f6G7h8I9', 'key [secret removed]'],
      ['https://app.example/cb?code=1&access_token=abc123def', 'https://app.example/cb?code=1&access_token=[secret removed]'],
    ];
    for (const [input, expected] of removed) expect(redactPastedSecrets(input).text, input).toBe(expected);

    const untouched = [
      OWNER_SOURCES.profileText,
      OWNER_SOURCES.csvText,
      'Paraboot Michael in UK 8.5, Drake’s rugby in XL, Levi’s 40x32 (mind the rise), Visvim D-43, New Balance 990v6 and 993, De Bonne Facture size 5',
      'https://www.drakes.com/products/navy-cotton-twill-chore-jacket?variant=40123456789012&utm_source=newsletter&gclid=Cj0KCQjw3kF9qLzP0aXw7Rt2Yb8NcVdA1b2C3',
      'Ask about garment g_0f3a9c2e5b7d4e1f8a6b9c0d2e4f6a8b and board brd_1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d',
      'SS24-OX-BD-0123, M990GL6, W40 L32, 15.5/39, GRDB is the app, rcv_ ids are fine alone',
    ];
    for (const t of untouched) expect(redactPastedSecrets(t)).toEqual({ text: t, redactions: [] });
  });

  it('the removal note card names its turn by the owner message id the app receives, so the app can tie it to that turn', async () => {
    installApiScenario();
    const owner = await apiOwner();
    const kit = await issueRecoveryCredential(db(), owner.userId);
    resetFake();
    const send = async (text: string) => TurnResponse.parse((await callJson('/v1/conversation/turns', { assertion: owner.assertion, body: { clientTurnId: turnId('notice'), text } })).body);
    const settle = async (runId: string) => {
      for (let i = 0; i < 200; i++) {
        const s = RunStatus.parse((await callJson(`/v1/runs/${runId}`, { assertion: owner.assertion })).body);
        if (['finished', 'failed', 'cancelled'].includes(s.status)) return;
        await new Promise((r) => setTimeout(r, 50));
      }
    };
    // Two turns with a pasted code each: identical notes, which the app must keep apart.
    const first = await send(`Keep this safe: ${kit.credential}`);
    await settle(first.runId);
    const second = await send(`And again: ${kit.credential}`);
    await settle(second.runId);
    expect(first.notice?.kind).toBe('secret_removed');
    const page = ConversationPage.parse((await callJson('/v1/conversation/messages?limit=50', { assertion: owner.assertion })).body);
    const notices = page.messages.flatMap((m) => m.parts.filter((p) => p.type === 'result_card' && p.kind === 'notice')) as { jobRef: string; title: string }[];
    expect(notices.map((n) => n.jobRef).sort()).toEqual([`message:${first.messageId}`, `message:${second.messageId}`].sort());
    // Each named message is the owner's own message for that turn (the app matches `message:<id>`).
    for (const t of [first, second]) {
      const mine = page.messages.find((m) => m.messageId === t.messageId);
      expect(mine?.role).toBe('user');
    }
    expect(notices.every((n) => n.title === 'Recovery code removed from your message')).toBe(true);
    expect(JSON.stringify(page)).not.toContain(kit.credential.split('.')[2]!);
  });
});
