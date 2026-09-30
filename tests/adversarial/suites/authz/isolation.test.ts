import { beforeAll, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:workers';
import { MediaService } from '../../../../backend/src/media/service.js';
import { MediaPipeline, handleMediaQueue } from '../../../../backend/src/media/pipeline.js';
import { LOCAL_DEV_SIGNING_KEY, mediaSigningKey, signToken } from '../../../../backend/src/media/signing.js';
import { exportOwnerData } from '../../../../backend/src/export/index.js';
import { createRecallService } from '../../../../backend/src/assistant/runtime.js';
import { applyDemoPlaceholders } from '@garderobe/demo';
import '../../helpers/assistant.js';
import { apiOwner, call, callJson, idem, installApiScenario, prepareToday, type ApiOwner } from '../../helpers/http.js';
import { connectMcp, mcpGrant, tool } from '../../helpers/mcp.js';
import { count, one } from '../../helpers/seed.js';

/**
 * Cross-owner isolation: owner A (the real owner's data) and owner B (the same real data imported for
 * a second identity, so every garment name exists on both sides and only ownership differs). B tries
 * every identifier of A's that could leak: garments, receipts, runs, recall, media, exports, queue
 * messages and MCP grants. Answers must be indistinguishable from "missing".
 */

const SECRET = 'Tyrolean-loden-secret-7f3e';

describe('cross-owner access over HTTP, recall, media, exports, queues and MCP', () => {
  let a: ApiOwner;
  let b: ApiOwner;
  let aShirt: string;
  let aCommand: string;
  let aRun: string;
  let aAssets: string[];
  let aJob: string;
  let clockNow: () => string;

  beforeAll(async () => {
    clockNow = installApiScenario().clock.now;
    a = await apiOwner();
    b = await apiOwner('Owner B');
    aShirt = await a.byName('Lightweight oxford — gold');
    await prepareToday(a.assertion);
    const w = await callJson<{ commandId: string }>('/v1/commands', { assertion: a.assertion, body: { idempotencyKey: idem(), source: 'app', command: { type: 'record_wear', timezone: 'Europe/London', wearingDate: '2026-10-05', items: [{ garmentId: aShirt }] } } });
    aCommand = w.body.commandId;
    const t = await callJson<{ runId: string }>('/v1/conversation/turns', { assertion: a.assertion, body: { clientTurnId: `turn-${crypto.randomUUID()}`, text: `Remember my ${SECRET} story about the loden coat.` } });
    aRun = t.body.runId;
    for (let i = 0; i < 50; i++) {
      const s = await callJson<{ status: string }>(`/v1/runs/${aRun}`, { assertion: a.assertion });
      if (['finished', 'failed', 'cancelled'].includes(s.body.status)) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    const media = new MediaService({ db: env.DB, bucket: env.MEDIA, principal: a.principal, signingKey: LOCAL_DEV_SIGNING_KEY });
    await applyDemoPlaceholders(env.DB, media, { garmentIds: [aShirt, await a.byName('NB 990v4 — grey')] });
    aAssets = (await env.DB.prepare("SELECT asset_id FROM media_assets WHERE user_id = ? AND status = 'final' ORDER BY asset_id").bind(a.userId).all<{ asset_id: string }>()).results.map((r) => r.asset_id);
    const pipeline = new MediaPipeline({ db: env.DB, bucket: env.MEDIA, principal: a.principal, signingKey: LOCAL_DEV_SIGNING_KEY, queue: null, providers: {} });
    aJob = await pipeline.enqueueDiscovery(aShirt, 'adversarial');
  });

  it('B gets 404 for A\'s garment, receipt, run, run events, run cancel and run input', async () => {
    expect((await call(`/v1/items/${aShirt}`, { assertion: b.assertion })).status).toBe(404);
    expect((await call(`/v1/commands/${aCommand}`, { assertion: b.assertion })).status).toBe(404);
    expect(aRun).toMatch(/^run_/);
    expect((await call(`/v1/runs/${aRun}`, { assertion: b.assertion })).status).toBe(404);
    expect((await call(`/v1/runs/${aRun}/events?follow=0`, { assertion: b.assertion })).status).toBe(404);
    expect((await call(`/v1/runs/${aRun}/cancel`, { assertion: b.assertion, body: {} })).status).toBe(404);
    expect((await call(`/v1/runs/${aRun}/input`, { assertion: b.assertion, body: { choiceId: 'confirm' } })).status).toBe(404);
    const receipts = await callJson('/v1/receipts?limit=200', { assertion: b.assertion });
    expect(receipts.text).not.toContain(aCommand);
    // And existence is not leaked: a random id gives the same answer.
    expect((await call('/v1/items/g_00000000000000000000000000000000', { assertion: b.assertion })).status).toBe(404);
  });

  it('B cannot act on A\'s garments or boards through commands; the rejection is not_found', async () => {
    const board = await callJson<{ board: { boardId: string; options: { optionId: string }[] } }>('/v1/today', { assertion: a.assertion });
    const before = await count('SELECT COUNT(*) AS n FROM command_receipts WHERE user_id = ?', a.userId);
    for (const command of [
      { type: 'mark_in_wash', garmentId: aShirt },
      { type: 'record_wear', timezone: 'Europe/London', items: [{ garmentId: aShirt }] },
      { type: 'select_option', boardId: board.body.board.boardId, optionId: board.body.board.options[0]!.optionId },
      { type: 'undo', targetCommandId: aCommand },
      { type: 'dispose_item', garmentId: aShirt, reason: 'sold' },
    ]) {
      const r = await callJson<{ outcome: string; error: { code: string } }>('/v1/commands', { assertion: b.assertion, body: { idempotencyKey: idem(), source: 'app', command } });
      expect(r.body.outcome, command.type).toBe('rejected');
      expect(r.body.error.code, command.type).toBe('not_found');
    }
    expect(await count('SELECT COUNT(*) AS n FROM command_receipts WHERE user_id = ?', a.userId)).toBe(before);
  });

  it('B cannot reuse A\'s idempotency key to read A\'s receipt', async () => {
    const row = await one<{ idempotency_key: string; request_json?: string }>('SELECT idempotency_key FROM command_receipts WHERE user_id = ? AND command_id = ?', a.userId, aCommand);
    const r = await callJson<{ commandId?: string; replayed?: boolean }>('/v1/commands', { assertion: b.assertion, body: { idempotencyKey: row.idempotency_key, source: 'app', command: { type: 'record_wear', timezone: 'Europe/London', wearingDate: '2026-10-05', items: [{ garmentId: aShirt }] } } });
    expect(r.body.commandId).not.toBe(aCommand);
    expect(r.text).not.toContain(a.userId);
  });

  it('recall never returns A\'s messages to B', async () => {
    const recall = createRecallService({ DB: env.DB } as never);
    const hitsOf = (x: unknown) => JSON.stringify((x as { hits?: unknown }).hits ?? x);
    const probe = { query: 'loden coat story', timezone: 'Europe/London', now: new Date().toISOString() } as never;
    expect(hitsOf(await recall.search(b.principal, probe))).not.toContain(SECRET);
    expect(hitsOf(await recall.search(a.principal, probe)), 'control: A finds its own message').toContain(SECRET);
    expect(hitsOf(await recall.search(b.principal, { query: SECRET, timezone: 'Europe/London', now: new Date().toISOString() } as never))).not.toContain(SECRET);
    const r = await callJson<{ hits?: unknown }>('/v1/recall/search', { assertion: b.assertion, body: { query: 'loden coat story' } });
    expect(r.status).toBeLessThan(500);
    expect(JSON.stringify(r.body.hits ?? [])).not.toContain(SECRET);
    const msgs = await callJson('/v1/conversation/messages?limit=100', { assertion: b.assertion });
    expect(msgs.text).not.toContain(SECRET);
  });

  it('media: B\'s session cannot fetch A\'s asset; signed links are bound to one owner, one object and an expiry', async () => {
    expect(aAssets.length).toBeGreaterThanOrEqual(2);
    const [x, y] = aAssets as [string, string];
    expect((await call(`/v1/media/${x}`, { assertion: a.assertion })).status).toBe(200);
    expect((await call(`/v1/media/${x}`, { assertion: b.assertion })).status).toBe(404);
    const nowS = Math.floor(Date.parse(clockNow()) / 1000); // the API's clock, not the host's
    const exp = nowS + 600;
    const good = await signToken(LOCAL_DEV_SIGNING_KEY, { purpose: 'media', userId: a.userId, objectId: x, exp });
    expect((await call(`/v1/media/${x}?t=${encodeURIComponent(good)}`)).status).toBe(200);
    expect((await call(`/v1/media/${y}?t=${encodeURIComponent(good)}`)).status).toBe(404); // token for x used on y
    const asB = await signToken(LOCAL_DEV_SIGNING_KEY, { purpose: 'media', userId: b.userId, objectId: x, exp });
    expect((await call(`/v1/media/${x}?t=${encodeURIComponent(asB)}`)).status).toBe(404); // right object, wrong owner
    const upload = await signToken(LOCAL_DEV_SIGNING_KEY, { purpose: 'upload', userId: a.userId, objectId: x, exp });
    expect((await call(`/v1/media/${x}?t=${encodeURIComponent(upload)}`)).status).toBe(404); // wrong purpose
    const expired = await signToken(LOCAL_DEV_SIGNING_KEY, { purpose: 'media', userId: a.userId, objectId: x, exp: nowS - 5 });
    expect((await call(`/v1/media/${x}?t=${encodeURIComponent(expired)}`)).status).toBe(403);
    const [p, s] = good.split('.');
    const flipped = `${p}.${s!.slice(0, -2)}${s!.slice(-2) === 'AA' ? 'AB' : 'AA'}`;
    expect((await call(`/v1/media/${x}?t=${encodeURIComponent(flipped)}`)).status).toBe(404);
    const other = await signToken('x'.repeat(40), { purpose: 'media', userId: a.userId, objectId: x, exp });
    expect((await call(`/v1/media/${x}?t=${encodeURIComponent(other)}`)).status).toBe(404);
    expect((await call(`/v1/media/../../${x}`, { assertion: b.assertion })).status).toBeGreaterThanOrEqual(400);
  });

  it('the well-known local signing key is refused outside local environments', () => {
    expect(() => mediaSigningKey({ ENVIRONMENT: 'dev' })).toThrow();
    expect(() => mediaSigningKey({ ENVIRONMENT: 'production' })).toThrow();
    expect(mediaSigningKey({ ENVIRONMENT: 'dev', MEDIA_URL_SIGNING_KEY: 'k'.repeat(40) })).toBe('k'.repeat(40));
  });

  it('B\'s export contains nothing of A\'s', async () => {
    const pkg = await exportOwnerData(env.DB, b.principal);
    const all = JSON.stringify(pkg);
    expect(all).not.toContain(a.userId);
    expect(all).not.toContain(aShirt);
    expect(all).not.toContain(aCommand);
    expect(all).not.toContain(SECRET);
    for (const id of aAssets) expect(all).not.toContain(id);
  });

  it('a queue message (or a retry of one) naming B with A\'s job id runs nothing of A\'s and is not retried', async () => {
    const before = await one<{ status: string; attempts: number }>('SELECT status, attempts FROM media_jobs WHERE user_id = ? AND job_id = ?', a.userId, aJob);
    const acked: string[] = [];
    const retried: string[] = [];
    const msg = (body: unknown, attempts: number, id: string) => ({ id, timestamp: new Date(), body, attempts, ack: () => acked.push(id), retry: () => retried.push(id) });
    const batch = {
      queue: 'garderobe-media',
      messages: [
        msg({ v: 1, userId: b.userId, jobId: aJob }, 1, 'forged-owner'),
        msg({ v: 1, userId: b.userId, jobId: aJob }, 3, 'forged-owner-retry'),
        msg({ v: 1, userId: 'usr_doesnotexist', jobId: aJob }, 1, 'unknown-user'),
        msg({ v: 1, userId: a.userId, jobId: `mjb_${'0'.repeat(32)}` }, 1, 'unknown-job'),
        msg({ v: 1, userId: `${a.userId}' OR '1'='1`, jobId: aJob }, 1, 'sql-owner'),
        msg({ v: 2, userId: a.userId, jobId: aJob, extra: 'x' }, 1, 'bad-version'),
        msg('not-json', 1, 'garbage'),
      ],
      retryAll: () => undefined,
      ackAll: () => undefined,
    };
    await handleMediaQueue(batch as never, env as never, { providers: {} });
    expect(acked.sort()).toEqual(['bad-version', 'forged-owner', 'forged-owner-retry', 'garbage', 'sql-owner', 'unknown-job', 'unknown-user']);
    expect(retried).toEqual([]);
    expect(await one('SELECT status, attempts FROM media_jobs WHERE user_id = ? AND job_id = ?', a.userId, aJob)).toEqual(before);
  });

  it('MCP: B\'s grant cannot read A\'s garments, runs or conversation, nor disconnect A\'s grants', async () => {
    const aGrant = await mcpGrant(a.assertion, 'claude');
    const bGrant = await mcpGrant(b.assertion, 'claude');
    const c = await connectMcp(bGrant.accessToken);
    const item = await tool(c, 'garderobe_inventory', { view: 'item', garmentId: aShirt });
    expect(item.isError).toBe(true);
    const run = await tool(c, 'garderobe_run', { runId: aRun });
    expect(run.isError).toBe(true);
    const cancel = await tool(c, 'garderobe_run', { runId: aRun, action: 'cancel' });
    expect(cancel.isError).toBe(true);
    const aHandle = `cnv_${[...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`conversation:${a.userId}`)))].map((x) => x.toString(16).padStart(2, '0')).join('').slice(0, 24)}`;
    const ask = await tool(c, 'garderobe_ask', { text: 'What did I say about loden?', conversation: aHandle });
    expect(ask.isError).toBe(true);
    const history = await tool(c, 'garderobe_inventory', { view: 'history', garmentId: aShirt });
    expect(JSON.stringify(history)).not.toContain('2026-10-05');
    await c.close();
    const aGrantRow = await one<{ grant_id: string }>("SELECT grant_id FROM mcp_grants WHERE user_id = ? AND client_id = ? AND status = 'active'", a.userId, aGrant.clientId);
    const d = await call(`/v1/connections/${aGrantRow.grant_id}/disconnect`, { assertion: b.assertion, body: {} });
    expect(d.status).toBe(404);
    expect(await count("SELECT COUNT(*) AS n FROM mcp_grants WHERE user_id = ? AND grant_id = ? AND status = 'active'", a.userId, aGrantRow.grant_id)).toBe(1);
    // A's token only ever acts as A.
    const ca = await connectMcp(aGrant.accessToken);
    const mine = await tool(ca, 'garderobe_inventory', { view: 'item', garmentId: aShirt });
    expect(mine.isError).toBeFalsy();
    await ca.close();
  });

  it('SQLite itself refuses cross-owner references (compound foreign keys)', async () => {
    const bShirt = await b.byName('Lightweight oxford — gold');
    await expect(env.DB.prepare("INSERT INTO daily_wears (user_id, garment_id, wearing_date, status, observation_id, counted_at) VALUES (?, ?, '2026-10-01', 'active', 'obs_x', '2026-10-01T08:00:00Z')").bind(b.userId, aShirt).run()).rejects.toThrow();
    expect(bShirt).not.toBe(aShirt);
  });
});
