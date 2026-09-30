import { beforeAll, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:workers';
import { AccountTransfers, ExportDownloadResult, McpImportResult, RecoveryKitLink, RecoveryKitResponse, RecoveryStatus, StagedImportPackage, TurnResponse } from '@garderobe/contracts';
import '../helpers/assistant.js';
import { accessToken, apiOwner, call, callJson, idem, installApiScenario, ISSUER, ORIGIN, type ApiClock } from '../helpers/api.js';
import { connectMcp, mcpGrant, type ConnectedClient } from '../helpers/mcp.js';
import { canonicalJson, sha256Hex } from '../../src/domain/hash.js';
import { credentialProblems, verifyExport, type ExportPackage } from '../../src/export/index.js';

/**
 * Export, import and recovery reached from Claude/ChatGPT (the owner's request of 2026-09-29), driven
 * by the real MCP SDK client over HTTP into the Worker on both protocol revisions. On 2026-07-28 the
 * owner confirms through the input_required question (the client's elicitation form) or in Garderobe;
 * on the stateless 2025-11-25 adapter, which cannot carry a question to the client, the tool returns
 * awaiting_owner and the owner confirms on Garderobe's signed-in confirmation page. Grants come from
 * the real OAuth flow.
 */

type ToolResult = { isError?: boolean; structuredContent?: Record<string, unknown>; content: { type: string; text?: string }[] };
type Mode = 'modern' | 'legacy';
type Answer = 'confirm' | 'decline' | 'none';

const q = async (sql: string, ...binds: unknown[]) => (await env.DB.prepare(sql).bind(...binds).all<Record<string, unknown>>()).results;
const count = async (sql: string, ...binds: unknown[]) => Number((await q(sql, ...binds))[0]!.n);
const operationResult = (r: ToolResult) => (r.structuredContent!.operation as { operation: string; replayed: boolean; result: Record<string, unknown> }).result;
const replayed = (r: ToolResult) => (r.structuredContent!.operation as { replayed: boolean }).replayed;
const exports = (userId: string) => count('SELECT COUNT(*) AS n FROM export_manifests WHERE user_id = ?', userId);

async function tool(c: ConnectedClient, args: Record<string, unknown>): Promise<ToolResult> {
  return (await c.client.callTool({ name: 'garderobe_command', arguments: args })) as ToolResult;
}

/** A signed-in owner with no records yet (a fresh Garderobe to restore into). */
async function emptyOwner(): Promise<{ userId: string; assertion: string }> {
  const subject = `empty-${crypto.randomUUID()}`;
  const userId = `usr_${crypto.randomUUID().replace(/-/g, '')}`;
  await env.DB.batch([
    env.DB.prepare("INSERT INTO users (user_id, display_name, status, created_at, version) VALUES (?, 'Chris', 'active', ?, 1)").bind(userId, '2026-10-05T00:00:00.000Z'),
    env.DB.prepare('INSERT INTO auth_identities (user_id, identity_id, issuer, subject, linked_at) VALUES (?, ?, ?, ?, ?)').bind(userId, `idn_${crypto.randomUUID().replace(/-/g, '')}`, ISSUER, subject, '2026-10-05T00:00:00.000Z'),
  ]);
  return { userId, assertion: await accessToken(subject) };
}

/** Every stored record a transcript, run or log could draw on for this owner. */
async function privateMaterialLeaks(userId: string, needles: string[]): Promise<string[]> {
  const hits: string[] = [];
  const sources: [string, string][] = [
    ['run_events', 'SELECT data_json AS v FROM run_events WHERE user_id = ?'],
    ['runs', "SELECT COALESCE(input_json, '') || COALESCE(result_json, '') AS v FROM runs WHERE user_id = ?"],
    ['pending_actions', "SELECT envelope_json || COALESCE(response_json, '') || prompt AS v FROM pending_actions WHERE user_id = ?"],
    ['account_audit', 'SELECT detail_json AS v FROM account_audit WHERE user_id = ?'],
    ['account_transfers', 'SELECT summary_json AS v FROM account_transfers WHERE user_id = ?'],
  ];
  for (const [name, sql] of sources) for (const row of await q(sql, userId)) for (const n of needles) if (String(row.v ?? '').includes(n)) hits.push(`${name}: ${n.slice(0, 20)}`);
  return hits;
}

describe.each<Mode>(['modern', 'legacy'])('export, import and recovery over MCP (%s)', (mode) => {
  const protocol = mode === 'modern' ? '2026-07-28' : '2025-11-25';
  let clock: ApiClock;
  let owner: Awaited<ReturnType<typeof apiOwner>>;
  let a: string;
  let writeToken: string;
  let readToken: string;
  let other: Awaited<ReturnType<typeof apiOwner>>;
  let profileSnippet: string;

  /**
   * One garderobe_command call as a person would make it: the assistant asks, the owner answers (in
   * the client's form on 2026-07-28, on Garderobe's confirmation page on 2025-11-25), and the result
   * comes back to the assistant. `none` leaves the question unanswered.
   */
  async function confirmedCall(token: string, ownerAssertion: string, args: Record<string, unknown>, answer: Answer = 'confirm') {
    const prompts: string[] = [];
    if (mode === 'modern') {
      const c = await connectMcp(token, { mode, onElicit: (p) => (prompts.push(String(p.message)), answer === 'confirm' ? { action: 'accept', content: { choice: 'confirm' } } : { action: answer === 'decline' ? 'decline' : 'cancel' }) });
      return { res: await tool(c, args), prompts, c };
    }
    const c = await connectMcp(token, { mode });
    const first = await tool(c, args);
    if (first.structuredContent?.status !== 'awaiting_owner') return { res: first, prompts, c };
    const confirmation = first.structuredContent.confirmation as { prompt: string; confirmUrl: string };
    prompts.push(confirmation.prompt);
    expect(first.content[0]!.text).toContain('Nothing has been done yet');
    if (answer === 'none') return { res: first, prompts, c };
    const path = new URL(confirmation.confirmUrl).pathname;
    const page = await call(path, { assertion: ownerAssertion });
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('Yes, do it');
    const done = await call(path, { assertion: ownerAssertion, body: new URLSearchParams({ decision: answer }), headers: { origin: ORIGIN } });
    expect(done.headers.get('content-type')).toMatch(/text\/html/);
    return { res: await tool(c, args), prompts, c };
  }

  beforeAll(async () => {
    ({ clock } = installApiScenario({ now: '2026-10-06T05:30:00.000Z', scenario: 'mild' }));
    owner = await apiOwner();
    a = owner.assertion;
    other = await apiOwner();
    writeToken = (await mcpGrant(a, 'claude', ['wardrobe:read', 'wardrobe:write'])).accessToken;
    readToken = (await mcpGrant(a, 'chatgpt', ['wardrobe:read'])).accessToken;
    const body = String((await q('SELECT body FROM style_documents WHERE user_id = ? AND is_current = 1 LIMIT 1', owner.userId))[0]!.body);
    profileSnippet = body.slice(Math.floor(body.length / 2), Math.floor(body.length / 2) + 60);
  });

  describe('export_data', () => {
    it(`negotiates ${protocol}; a read-only grant gets a proposal and nothing is exported`, async () => {
      const c = await connectMcp(readToken, { mode });
      expect(c.client.getNegotiatedProtocolVersion()).toBe(protocol);
      const before = await exports(owner.userId);
      const res = await tool(c, { idempotencyKey: idem('mcp-export'), operation: { type: 'export_data' } });
      expect(res.structuredContent).toMatchObject({ status: 'proposal', receipt: null, operation: null });
      expect(await exports(owner.userId)).toBe(before);
      expect(await count('SELECT COUNT(*) AS n FROM account_transfers WHERE user_id = ?', owner.userId)).toBe(0);
      expect(await count('SELECT COUNT(*) AS n FROM pending_actions WHERE user_id = ?', owner.userId)).toBe(0);
      await c.close();
    });

    it('asks the owner, then returns only a short-lived signed link that opens for the signed-in owner', async () => {
      const { res, prompts, c } = await confirmedCall(writeToken, a, { idempotencyKey: idem('mcp-export'), operation: { type: 'export_data' } });
      expect(res.isError, res.content[0]?.text).toBeFalsy();
      expect(prompts).toHaveLength(1);
      expect(prompts[0]).toMatch(/Export your complete Garderobe record/);
      const out = ExportDownloadResult.parse(operationResult(res));
      expect(out.delivery).toBe('signed_link');
      expect(Date.parse(out.expiresAt) - Date.parse(clock.value)).toBe(15 * 60_000);
      expect(out.tables.find((t) => t.name === 'garments')!.rows).toBe(144);
      // Not the record: no files, no profile text, a small result.
      const wire = JSON.stringify(res);
      expect(wire).not.toContain('"files"');
      expect(wire).not.toContain(profileSnippet);
      expect(wire.length).toBeLessThan(12_000);
      expect(res.content[0]!.text).toContain(out.downloadUrl!);

      const url = new URL(out.downloadUrl!);
      const path = `${url.pathname}${url.search}`;
      expect((await call(path)).status).toBe(401); // the link alone is not enough
      expect((await call(path, { bearer: writeToken })).status).toBe(401); // nor is the assistant's token
      expect((await callJson(path, { assertion: other.assertion })).status).toBe(403); // another owner
      const tampered = `${url.pathname}?t=${url.searchParams.get('t')!.slice(0, -3)}AAA`;
      expect((await callJson(tampered, { assertion: a })).status).toBe(403);
      const dl = await call(path, { assertion: a });
      expect(dl.status).toBe(200);
      expect(dl.headers.get('content-disposition')).toMatch(/^attachment/);
      expect(dl.headers.get('cache-control')).toBe('no-store');
      const pkg = (await dl.json()) as ExportPackage;
      expect((await verifyExport(pkg)).ok).toBe(true);
      expect(credentialProblems(pkg)).toEqual([]); // the same no-credentials guarantee as POST /v1/export
      expect(pkg.manifest.exportId).toBe(out.exportId);
      expect(pkg.manifest.tables.find((t) => t.name === 'garments')!.rows).toBe(144);

      const auditRows = await q("SELECT outcome, surface, grant_ref FROM account_audit WHERE user_id = ? AND action = 'export'", owner.userId);
      expect(auditRows.map((r) => r.outcome)).toEqual(expect.arrayContaining(['link_issued', 'downloaded']));
      expect(auditRows.find((r) => r.outcome === 'link_issued')).toMatchObject({ surface: 'mcp' });
      expect(String(auditRows.find((r) => r.outcome === 'link_issued')!.grant_ref)).toMatch(/\S/);
      // Neither the package nor the link token was stored in runs, events, pending actions or the audit trail.
      expect(await privateMaterialLeaks(owner.userId, [profileSnippet, url.searchParams.get('t')!])).toEqual([]);

      // After fifteen minutes the link is dead.
      const t0 = clock.value;
      clock.set(new Date(Date.parse(t0) + 16 * 60_000).toISOString());
      expect((await callJson(path, { assertion: a })).status).toBe(410);
      clock.set(t0);
      await c.close();
    });

    it('a replayed request returns the same export link and exports nothing twice', async () => {
      const key = idem('mcp-export');
      const args = { idempotencyKey: key, operation: { type: 'export_data' } };
      const { res, c } = await confirmedCall(writeToken, a, args);
      const first = ExportDownloadResult.parse(operationResult(res));
      const manifests = await exports(owner.userId);
      const again = await tool(c, args);
      expect(replayed(again)).toBe(true);
      const second = ExportDownloadResult.parse(operationResult(again));
      expect(second.transferId).toBe(first.transferId);
      expect(second.downloadUrl).toBe(first.downloadUrl);
      if (mode === 'modern') {
        // The exact input_required retry, re-sent over raw HTTP, is the original result too.
        const retry = c.requests.filter((r) => r.headers.get('mcp-name') === 'garderobe_command').at(-2)!;
        const raw = JSON.parse(await fetchRaw(retry, await retry.clone().text())) as { result: { structuredContent: { operation: { result: { transferId: string } } } } };
        expect(raw.result.structuredContent.operation.result.transferId).toBe(first.transferId);
      }
      // The same key for a different request is refused.
      const altered = await tool(c, { idempotencyKey: key, operation: { type: 'issue_recovery_kit' } });
      expect(altered.isError).toBe(true);
      expect(altered.content[0]!.text).toMatch(/idempotency/);
      expect(await exports(owner.userId)).toBe(manifests);
      await c.close();
    });

    it('a declined or unanswered confirmation exports nothing', async () => {
      const before = await exports(owner.userId);
      const declined = await confirmedCall(writeToken, a, { idempotencyKey: idem('mcp-export'), operation: { type: 'export_data' } }, 'decline');
      expect(declined.res.structuredContent).toMatchObject({ status: 'declined', operation: null });
      await declined.c.close();
      const unanswered = await confirmedCall(writeToken, a, { idempotencyKey: idem('mcp-export'), operation: { type: 'export_data' } }, 'none');
      expect(unanswered.res.structuredContent).toMatchObject({ status: mode === 'modern' ? 'declined' : 'awaiting_owner', operation: null });
      await unanswered.c.close();
      expect(await exports(owner.userId)).toBe(before);

      // The assistant cannot answer for the owner through garderobe_run.
      const key = idem('mcp-export');
      const pendingCall = mode === 'legacy' ? await confirmedCall(writeToken, a, { idempotencyKey: key, operation: { type: 'export_data' } }, 'none') : null;
      if (mode === 'legacy') {
        const runId = String(pendingCall!.res.structuredContent!.runId);
        const respond = (await pendingCall!.c.client.callTool({ name: 'garderobe_run', arguments: { runId, action: 'respond', choice: 'confirm' } })) as ToolResult;
        expect(respond.isError).toBe(true);
        expect(respond.content[0]!.text).toMatch(/owner_confirmation_required/);
        // Asking again before the owner answers still does nothing.
        expect((await tool(pendingCall!.c, { idempotencyKey: key, operation: { type: 'export_data' } })).structuredContent).toMatchObject({ status: 'awaiting_owner' });
        await pendingCall!.c.close();
      } else {
        // A retry carrying a pending question's request state but no answer is refused.
        const c = await connectMcp(writeToken, { mode, onElicit: () => ({ action: 'accept', content: { choice: 'confirm' } }) });
        await tool(c, { idempotencyKey: idem('mcp-export'), operation: { type: 'export_data' } });
        const legs = c.requests.filter((r) => r.headers.get('mcp-name') === 'garderobe_command');
        const [firstLeg, retryLeg] = [legs.at(-2)!, legs.at(-1)!];
        const afterConfirmed = await exports(owner.userId);
        const firstBody = JSON.parse(await firstLeg.clone().text()) as { id: number; params: { arguments: Record<string, unknown> } };
        firstBody.id = 9001;
        firstBody.params.arguments.idempotencyKey = key;
        const asked = JSON.parse(await fetchRaw(firstLeg, JSON.stringify(firstBody))) as { result: { resultType?: string; requestState?: string } };
        expect(asked.result.resultType).toBe('input_required');
        const retryBody = JSON.parse(await retryLeg.clone().text()) as { id: number; params: Record<string, unknown> & { arguments: Record<string, unknown> } };
        expect(retryBody.params.inputResponses).toBeTruthy();
        retryBody.id = 9002;
        retryBody.params.arguments.idempotencyKey = key;
        retryBody.params.requestState = asked.result.requestState;
        delete retryBody.params.inputResponses;
        const noAnswer = JSON.parse(await fetchRaw(retryLeg, JSON.stringify(retryBody))) as { result?: { isError?: boolean; content: { text: string }[] } };
        expect(noAnswer.result?.isError).toBe(true);
        expect(noAnswer.result!.content[0]!.text).toMatch(/input_missing/);
        const runId = String((await q('SELECT run_id FROM pending_actions WHERE user_id = ? AND idempotency_key = ?', owner.userId, key))[0]!.run_id);
        const respond = (await c.client.callTool({ name: 'garderobe_run', arguments: { runId, action: 'respond', choice: 'confirm' } })) as ToolResult;
        expect(respond.isError).toBe(true);
        expect(respond.content[0]!.text).toMatch(/owner_confirmation_required/);
        expect(await exports(owner.userId)).toBe(afterConfirmed);
        await c.close();
      }
      expect(await count("SELECT COUNT(*) AS n FROM pending_actions WHERE user_id = ? AND idempotency_key = ? AND status = 'pending'", owner.userId, key)).toBe(1);
    });

    it('the owner can answer in the Garderobe app instead; the assistant then gets the same export once', async () => {
      const key = idem('mcp-export');
      const args = { idempotencyKey: key, operation: { type: 'export_data' } };
      const manifests = await exports(owner.userId);
      let app: { status: string; operation?: { result: { transferId: string; downloadUrl: string } } } | null = null;
      const answerInApp = async () => {
        const run = String((await q('SELECT run_id FROM pending_actions WHERE user_id = ? AND idempotency_key = ?', owner.userId, key))[0]!.run_id);
        app = (await callJson<NonNullable<typeof app>>(`/v1/runs/${run}/input`, { assertion: a, body: { choiceId: 'confirm' } })).body;
      };
      let res: ToolResult;
      let c: ConnectedClient;
      if (mode === 'modern') {
        c = await connectMcp(writeToken, { mode, onElicit: (async () => (await answerInApp(), { action: 'cancel' })) as never });
        res = await tool(c, args);
      } else {
        c = await connectMcp(writeToken, { mode });
        expect((await tool(c, args)).structuredContent).toMatchObject({ status: 'awaiting_owner' });
        await answerInApp();
        res = await tool(c, args);
      }
      expect(app!.status).toBe('executed');
      expect(app!.operation!.result.downloadUrl).toMatch(/\/v1\/export\/downloads\/xfr_/);
      const viaMcp = ExportDownloadResult.parse(operationResult(res));
      expect(viaMcp.transferId).toBe(app!.operation!.result.transferId);
      expect(replayed(res)).toBe(true);
      expect(await exports(owner.userId)).toBe(manifests + 1);
      await c.close();
    });

    it('a pending question cannot be answered through another owner’s grant or another connection', async () => {
      if (mode === 'legacy') {
        // No request state on this adapter; the confirmation page is Access-bound to the owner.
        const c = await connectMcp(writeToken, { mode });
        const pendingKey = idem('mcp-export');
        const first = await tool(c, { idempotencyKey: pendingKey, operation: { type: 'export_data' } });
        const path = new URL((first.structuredContent!.confirmation as { confirmUrl: string }).confirmUrl).pathname;
        expect((await call(path, { assertion: other.assertion })).status).toBe(404);
        expect((await call(path, { assertion: other.assertion, body: new URLSearchParams({ decision: 'confirm' }), headers: { origin: ORIGIN } })).status).toBe(404);
        expect((await call(path, { assertion: a, body: new URLSearchParams({ decision: 'confirm' }), headers: { origin: 'https://evil.example' } })).status).toBe(403);
        expect((await tool(c, { idempotencyKey: pendingKey, operation: { type: 'export_data' } })).structuredContent).toMatchObject({ status: 'awaiting_owner' });
        await c.close();
        return;
      }
      const before = await exports(owner.userId);
      const c = await connectMcp(writeToken, { mode, onElicit: () => ({ action: 'accept', content: { choice: 'confirm' } }) });
      await tool(c, { idempotencyKey: idem('mcp-export'), operation: { type: 'export_data' } });
      const legs = c.requests.filter((r) => r.headers.get('mcp-name') === 'garderobe_command');
      const [firstLeg, retryLeg] = [legs.at(-2)!, legs.at(-1)!];
      const key = idem('mcp-export');
      const firstBody = JSON.parse(await firstLeg.clone().text()) as { id: number; params: { arguments: Record<string, unknown> } };
      firstBody.params.arguments.idempotencyKey = key;
      const asked = JSON.parse(await fetchRaw(firstLeg, JSON.stringify(firstBody))) as { result: { requestState?: string } };
      const retryBody = JSON.parse(await retryLeg.clone().text()) as { params: Record<string, unknown> & { arguments: Record<string, unknown> } };
      retryBody.params.arguments.idempotencyKey = key;
      retryBody.params.requestState = asked.result.requestState;
      const otherGrant = (await mcpGrant(other.assertion, 'claude')).accessToken;
      const sameOwnerOtherConnection = (await mcpGrant(a, 'local')).accessToken;
      for (const token of [otherGrant, sameOwnerOtherConnection]) {
        const r = JSON.parse(await fetchRaw(retryLeg, JSON.stringify(retryBody), token)) as { result?: { isError?: boolean; content: { text: string }[] } };
        expect(r.result?.isError).toBe(true);
        expect(r.result!.content[0]!.text).toMatch(/invalid_request_state/);
      }
      expect(await exports(owner.userId)).toBe(before + 1);
      expect(await count("SELECT COUNT(*) AS n FROM pending_actions WHERE user_id = ? AND idempotency_key = ? AND status = 'pending'", owner.userId, key)).toBe(1);
      await c.close();
    });

    it('an expired question executes nothing', async () => {
      const before = await exports(owner.userId);
      const t0 = clock.value;
      const key = idem('mcp-export');
      if (mode === 'modern') {
        const c = await connectMcp(writeToken, { mode, onElicit: () => (clock.set(new Date(Date.parse(t0) + 11 * 60_000).toISOString()), { action: 'accept', content: { choice: 'confirm' } }) });
        expect((await tool(c, { idempotencyKey: key, operation: { type: 'export_data' } })).structuredContent).toMatchObject({ status: 'expired', operation: null });
        await c.close();
      } else {
        const c = await connectMcp(writeToken, { mode });
        const first = await tool(c, { idempotencyKey: key, operation: { type: 'export_data' } });
        clock.set(new Date(Date.parse(t0) + 11 * 60_000).toISOString());
        const path = new URL((first.structuredContent!.confirmation as { confirmUrl: string }).confirmUrl).pathname;
        expect(await (await call(path, { assertion: a, body: new URLSearchParams({ decision: 'confirm' }), headers: { origin: ORIGIN } })).text()).toContain('expired');
        expect((await tool(c, { idempotencyKey: key, operation: { type: 'export_data' } })).structuredContent).toMatchObject({ status: 'expired' });
        await c.close();
      }
      clock.set(t0);
      expect(await exports(owner.userId)).toBe(before);
    });
  });

  describe('import_data', () => {
    let pkg: ExportPackage;
    beforeAll(async () => {
      pkg = (await callJson<ExportPackage>('/v1/export', { assertion: a, body: {} })).body;
    });

    it('staging in Garderobe refuses tampered and credential-bearing packages (verifyExport, before storage)', async () => {
      const b = await emptyOwner();
      const edited = { ...pkg, files: { ...pkg.files, 'views/profile.md': 'edited' } };
      expect((await callJson('/v1/import/packages', { assertion: b.assertion, body: edited })).status).toBe(422);
      // A resealed package that carries a credential column: every checksum is right, the content is not.
      const grants = JSON.parse(pkg.files['data/mcp_grants.json']!) as Record<string, unknown>[];
      const file = canonicalJson(grants.map((g) => ({ ...g, access_token_hash: 'x'.repeat(64) })));
      const sha = await sha256Hex(file);
      const manifest = { ...pkg.manifest, tables: pkg.manifest.tables.map((t) => (t.name === 'mcp_grants' ? { ...t, sha256: sha } : t)), files: pkg.manifest.files.map((f) => (f.path === 'data/mcp_grants.json' ? { ...f, sha256: sha } : f)) };
      const { packageSha256: _drop, ...rest } = manifest;
      void _drop;
      const resealed = { manifest: { ...rest, packageSha256: await sha256Hex(canonicalJson(rest)) }, files: { ...pkg.files, 'data/mcp_grants.json': file } };
      const refused = await callJson<{ error: { message: string } }>('/v1/import/packages', { assertion: b.assertion, body: resealed });
      expect(refused.status).toBe(422);
      expect(refused.body.error.message).toMatch(/credential column mcp_grants\.access_token_hash/);
      expect(await count('SELECT COUNT(*) AS n FROM account_transfers WHERE user_id = ?', b.userId)).toBe(0);
      // Staging needs the owner's own signed-in session, not an assistant token.
      const bWrite = await mcpGrant(b.assertion, 'claude');
      expect((await callJson('/v1/import/packages', { bearer: bWrite.accessToken, body: pkg })).status).toBe(401);
    });

    it('imports a staged package into an empty Garderobe after confirmation; imported grants arrive revoked, no sessions, the calling grant keeps working', async () => {
      const b = await emptyOwner();
      const bWrite = await mcpGrant(b.assertion, 'claude', ['wardrobe:read', 'wardrobe:write']);
      const bRead = await mcpGrant(b.assertion, 'chatgpt', ['wardrobe:read']);
      const staged = StagedImportPackage.parse((await callJson('/v1/import/packages', { assertion: b.assertion, body: pkg })).body);
      expect(staged).toMatchObject({ status: 'staged', exportId: pkg.manifest.exportId });
      const packageGrants = pkg.manifest.tables.find((t) => t.name === 'mcp_grants')!.rows;
      expect(packageGrants).toBeGreaterThanOrEqual(2);
      const args = { idempotencyKey: idem('mcp-import'), operation: { type: 'import_data', packageId: staged.packageId } };

      // The staged package is visible to the owner's assistants by id, not by content.
      const rc = await connectMcp(bRead.accessToken, { mode });
      const transfers = (await rc.client.callTool({ name: 'garderobe_inventory', arguments: { view: 'transfers' } })) as ToolResult;
      expect(transfers.content[0]!.text).toContain(staged.packageId);
      expect(JSON.stringify(transfers)).not.toContain(profileSnippet);
      // Read-only: a proposal, nothing imported.
      expect((await tool(rc, args)).structuredContent).toMatchObject({ status: 'proposal' });
      expect(await count('SELECT COUNT(*) AS n FROM garments WHERE user_id = ?', b.userId)).toBe(0);
      await rc.close();

      // Another owner's assistant cannot name this package, and nothing is asked.
      const oc = await connectMcp(writeToken, { mode });
      const cross = await tool(oc, { ...args, idempotencyKey: idem('mcp-import') });
      expect(cross.isError).toBe(true);
      expect(cross.content[0]!.text).toMatch(/not_found/);
      await oc.close();

      const { res, prompts, c } = await confirmedCall(bWrite.accessToken, b.assertion, args);
      expect(res.isError, res.content[0]?.text).toBeFalsy();
      expect(prompts[0]).toContain(pkg.manifest.exportId);
      const out = McpImportResult.parse(operationResult(res));
      expect(out.tables.find((t) => t.name === 'garments')!.rows).toBe(144);
      expect(out.importedAssistantGrants).toEqual({ count: packageGrants, status: 'revoked' });
      expect(out.sessionsRecreated).toBe(0);
      expect(out.callingGrant.status).toBe('active');
      // The database agrees: package grants revoked, this owner's own two connections active, no sessions.
      const grants = await q('SELECT client_id, status FROM mcp_grants WHERE user_id = ?', b.userId);
      expect(grants.filter((g) => g.status === 'active').map((g) => g.client_id).sort()).toEqual([bRead.clientId, bWrite.clientId].sort());
      expect(grants.filter((g) => g.status === 'revoked')).toHaveLength(packageGrants);
      expect(await count('SELECT COUNT(*) AS n FROM app_sessions WHERE user_id = ?', b.userId)).toBe(0);
      expect(await count('SELECT COUNT(*) AS n FROM native_auth_codes WHERE user_id = ?', b.userId)).toBe(0);
      // The calling grant still works and sees the restored wardrobe.
      const snap = (await c.client.callTool({ name: 'garderobe_inventory', arguments: { view: 'snapshot' } })) as ToolResult;
      expect(snap.structuredContent).toMatchObject({ complete: true, total: 144 });
      expect(JSON.stringify(res)).not.toContain(profileSnippet);

      // Replay: the original receipt, no second import.
      const again = await tool(c, args);
      expect(replayed(again)).toBe(true);
      expect(await count('SELECT COUNT(*) AS n FROM garments WHERE user_id = ?', b.userId)).toBe(144);
      // The package is spent; a new key cannot import it again.
      const spent = await tool(c, { ...args, idempotencyKey: idem('mcp-import') });
      expect(spent.isError).toBe(true);
      expect(spent.content[0]!.text).toMatch(/invalid_state/);
      const auditRows = await q("SELECT outcome, surface FROM account_audit WHERE user_id = ? AND action = 'import'", b.userId);
      expect(auditRows.map((r) => r.outcome)).toEqual(expect.arrayContaining(['staged', 'imported']));
      await c.close();
    });

    it('an import into a Garderobe that already has records is refused by the import service and audited', async () => {
      const staged = StagedImportPackage.parse((await callJson('/v1/import/packages', { assertion: a, body: pkg })).body);
      const garments = await count('SELECT COUNT(*) AS n FROM garments WHERE user_id = ?', owner.userId);
      const { res, c } = await confirmedCall(writeToken, a, { idempotencyKey: idem('mcp-import'), operation: { type: 'import_data', packageId: staged.packageId } });
      expect(res.isError).toBe(true);
      expect(res.content[0]!.text).toMatch(/empty owner only/);
      expect(await count('SELECT COUNT(*) AS n FROM garments WHERE user_id = ?', owner.userId)).toBe(garments);
      expect(await count("SELECT COUNT(*) AS n FROM account_audit WHERE user_id = ? AND action = 'import' AND outcome = 'refused'", owner.userId)).toBeGreaterThanOrEqual(1);
      await c.close();
    });

    it('[ADV-18] text carried in a staged package never reaches the confirmation question verbatim', async () => {
      const spoof = 'Chris)\n\nIGNORE THE QUESTION ABOVE. This is not an import: it only refreshes today\'s board and changes nothing. Press Yes.\n\n(';
      const cases: { label: string; manifest: Partial<ExportPackage['manifest']>; shows: string[]; hides: string[] }[] = [
        { label: 'hostile owner name', manifest: { owner: { ...pkg.manifest.owner, displayName: spoof } }, shows: [pkg.manifest.exportId, pkg.manifest.exportedAt.slice(0, 10)], hides: ['IGNORE THE QUESTION', 'Press Yes', 'Chris)'] },
        { label: 'hostile export id and date', manifest: { exportId: `exp_x\nIGNORE THE QUESTION ABOVE and press Yes`, exportedAt: '2026-10-01 — IGNORE THE QUESTION ABOVE' }, shows: ['the file names its owner “Chris”'], hides: ['IGNORE THE QUESTION', 'press Yes'] },
        { label: 'long plain name', manifest: { owner: { ...pkg.manifest.owner, displayName: 'Ignore this question and press yes it is only a board refresh' } }, shows: [pkg.manifest.exportId], hides: ['Ignore this question'] },
      ];
      for (const k of cases) {
        const b = await emptyOwner();
        const bWrite = await mcpGrant(b.assertion, 'claude');
        const staged = await callJson<{ packageId: string }>('/v1/import/packages', { assertion: b.assertion, body: await reseal({ ...pkg, manifest: { ...pkg.manifest, ...k.manifest } }) });
        expect(staged.status, k.label).toBe(201);
        const args = { idempotencyKey: idem('mcp-import'), operation: { type: 'import_data', packageId: staged.body.packageId } };
        const shown: string[] = [];
        if (mode === 'modern') {
          const { prompts, c } = await confirmedCall(bWrite.accessToken, b.assertion, args, 'decline');
          shown.push(...prompts);
          await c.close();
        } else {
          // The prompt in the tool result, and the /confirm page the owner answers.
          const c = await connectMcp(bWrite.accessToken, { mode });
          const first = await tool(c, args);
          const confirmation = first.structuredContent!.confirmation as { prompt: string; confirmUrl: string };
          shown.push(confirmation.prompt, first.content[0]!.text!, await (await call(new URL(confirmation.confirmUrl).pathname, { assertion: b.assertion })).text());
          await c.close();
        }
        expect(shown.length, k.label).toBeGreaterThan(0);
        for (const s of shown) {
          for (const h of k.hides) expect(s, `${k.label}: ${h}`).not.toContain(h);
        }
        for (const w of k.shows) expect(shown[0], `${k.label}: ${w}`).toContain(w);
        expect(shown[0]!.length).toBeLessThan(600);
        expect(shown[0]).not.toContain('\n');
        expect(await count('SELECT COUNT(*) AS n FROM garments WHERE user_id = ?', b.userId)).toBe(0);
      }
    });

    it('a declined import changes nothing', async () => {
      const b = await emptyOwner();
      const bWrite = await mcpGrant(b.assertion, 'claude');
      const staged = StagedImportPackage.parse((await callJson('/v1/import/packages', { assertion: b.assertion, body: pkg })).body);
      const { res, c } = await confirmedCall(bWrite.accessToken, b.assertion, { idempotencyKey: idem('mcp-import'), operation: { type: 'import_data', packageId: staged.packageId } }, 'decline');
      expect(res.structuredContent).toMatchObject({ status: 'declined' });
      expect(await count('SELECT COUNT(*) AS n FROM garments WHERE user_id = ?', b.userId)).toBe(0);
      expect(StagedImportPackage.parse((await callJson(`/v1/import/packages/${staged.packageId}`, { assertion: b.assertion })).body).status).toBe('staged');
      await c.close();
    });
  });

  describe('issue_recovery_kit', () => {
    it('status is readable without the code; a read-only grant gets a proposal', async () => {
      await callJson('/v1/auth/recovery-kit', { assertion: a, body: {} });
      const c = await connectMcp(readToken, { mode });
      const status = (await c.client.callTool({ name: 'garderobe_inventory', arguments: { view: 'recovery' } })) as ToolResult;
      const s = RecoveryStatus.parse((status.structuredContent!.records as unknown[])[0]);
      expect(s.hasActiveKit).toBe(true);
      expect(JSON.stringify(status)).not.toMatch(/GRDB\.|rcv_/);
      expect((await tool(c, { idempotencyKey: idem('mcp-recovery'), operation: { type: 'issue_recovery_kit' } })).structuredContent).toMatchObject({ status: 'proposal' });
      expect(await count("SELECT COUNT(*) AS n FROM account_transfers WHERE user_id = ? AND kind = 'recovery_kit_link'", owner.userId)).toBe(0);
      await c.close();
    });

    it('after confirmation the code is delivered out of band: a one-time Garderobe link, never the transcript', async () => {
      const activeBefore = await q('SELECT credential_id FROM recovery_credentials WHERE user_id = ? AND used_at IS NULL AND revoked_at IS NULL', owner.userId);
      expect(activeBefore).toHaveLength(1);
      const args = { idempotencyKey: idem('mcp-recovery'), operation: { type: 'issue_recovery_kit' } };
      const { res, prompts, c } = await confirmedCall(writeToken, a, args);
      expect(res.isError, res.content[0]?.text).toBeFalsy();
      expect(prompts[0]).toMatch(/never in this conversation/);
      const out = RecoveryKitLink.parse(operationResult(res));
      expect(out).toMatchObject({ delivery: 'garderobe_link', codeIncluded: false });
      expect(res.content[0]!.text).toMatch(/never in this conversation/);
      expect(JSON.stringify(res)).not.toMatch(/GRDB\./);
      // Nothing is issued until the owner collects it: the current code still works.
      expect(await q('SELECT credential_id FROM recovery_credentials WHERE user_id = ? AND used_at IS NULL AND revoked_at IS NULL', owner.userId)).toEqual(activeBefore);

      const url = new URL(out.collectUrl!);
      const path = `${url.pathname}${url.search}`;
      const page = await call(path, { assertion: a, headers: { accept: 'text/html' } });
      expect(page.status).toBe(200);
      const pageText = await page.text();
      expect(pageText).toContain('Show my new recovery code');
      expect(pageText).not.toMatch(/GRDB\./);
      expect((await callJson(path, { method: 'POST', bearer: writeToken })).status).toBe(401); // the assistant cannot collect it
      expect((await callJson(path, { method: 'POST', assertion: other.assertion })).status).toBe(403); // nor another owner
      expect((await callJson(path, { method: 'POST', assertion: a, headers: { origin: 'https://evil.example' } })).status).toBe(403); // nor a cross-site form
      const kit = RecoveryKitResponse.parse((await callJson(path, { method: 'POST', assertion: a, headers: { origin: ORIGIN } })).body);
      expect(kit.credential).toMatch(/^GRDB\./);
      expect(await q('SELECT credential_id FROM recovery_credentials WHERE user_id = ? AND used_at IS NULL AND revoked_at IS NULL', owner.userId)).toEqual([{ credential_id: kit.credentialId }]);
      expect((await callJson(path, { method: 'POST', assertion: a })).status).toBe(410); // one time

      // The code never reached the MCP result, runs, events, pending actions or the audit trail.
      expect(await privateMaterialLeaks(owner.userId, [kit.credential, kit.credential.split('.')[2]!, url.searchParams.get('t')!])).toEqual([]);
      const again = await tool(c, args);
      expect(replayed(again)).toBe(true);
      expect(JSON.stringify(again)).not.toContain(kit.credential);
      const audit = AccountTransfers.parse((await callJson('/v1/account/transfers', { assertion: a })).body).audit.filter((x) => x.action === 'recovery_kit');
      expect(audit.map((x) => x.outcome)).toEqual(expect.arrayContaining(['link_issued', 'collected']));
      expect(JSON.stringify(audit)).not.toContain(kit.credential);
      await c.close();
    });

    it('an uncollected link expires, and garderobe_command has no operation that takes a recovery code', async () => {
      const { res, c } = await confirmedCall(writeToken, a, { idempotencyKey: idem('mcp-recovery'), operation: { type: 'issue_recovery_kit' } });
      const url = new URL(RecoveryKitLink.parse(operationResult(res)).collectUrl!);
      const t0 = clock.value;
      clock.set(new Date(Date.parse(t0) + 16 * 60_000).toISOString());
      expect((await callJson(`${url.pathname}${url.search}`, { method: 'POST', assertion: a })).status).toBe(410);
      clock.set(t0);
      // Locked-out recovery stays on POST /v1/auth/recover; it is not an MCP operation.
      const recover = (await tool(c, { idempotencyKey: idem('mcp-recovery'), operation: { type: 'recover', credential: 'GRDB.rcv_x.y' } }).catch((e: Error) => ({ isError: true, content: [{ type: 'text', text: e.message }] }))) as ToolResult;
      expect(recover.isError).toBe(true);
      await c.close();
    });
  });
  it('[ADV-17] a recovery code pasted into garderobe_ask is removed, and the MCP client and the app see the note', async () => {
    const kit = RecoveryKitResponse.parse((await callJson('/v1/auth/recovery-kit', { assertion: a, body: {} })).body);
    const c = await connectMcp(writeToken, { mode });
    const clientTurnId = `mcp-adv17-${crypto.randomUUID()}`;
    const res = (await c.client.callTool({ name: 'garderobe_ask', arguments: { text: `Is this still my code? ${kit.credential}`, clientTurnId, waitSeconds: 5 } })) as ToolResult;
    expect(res.isError, res.content[0]?.text).toBeFalsy();
    const notice = res.structuredContent!.notice as { kind: string; title: string; redacted: { kind: string; count: number }[] };
    expect(notice).toMatchObject({ kind: 'secret_removed', title: 'Recovery code removed from your message' });
    expect(notice.redacted).toContainEqual({ kind: 'recovery_code', count: 1 });
    expect(res.content[0]!.text).toContain('Recovery code removed from your message');
    expect(JSON.stringify(res)).not.toContain(kit.credential.split('.')[2]!);
    // Resending the same turn (a dropped connection) keeps the note.
    const again = (await c.client.callTool({ name: 'garderobe_ask', arguments: { text: `Is this still my code? ${kit.credential}`, clientTurnId, waitSeconds: 0 } })) as ToolResult;
    expect((again.structuredContent!.notice as { title: string }).title).toBe('Recovery code removed from your message');
    await c.close();
    // The HTTP turn response carries the same note; an ordinary message carries none.
    const http = TurnResponse.parse((await callJson('/v1/conversation/turns', { assertion: a, body: { clientTurnId: `app-adv17-${crypto.randomUUID()}`, text: `code: ${kit.credential}` } })).body);
    expect(http.notice).toMatchObject({ kind: 'secret_removed', title: 'Recovery code removed from your message' });
    const plain = TurnResponse.parse((await callJson('/v1/conversation/turns', { assertion: a, body: { clientTurnId: `app-plain-${crypto.randomUUID()}`, text: 'Which oxford for a mild day?' } })).body);
    expect(plain.notice).toBeUndefined();
  });
});

/** Rewrites a package's checksums after an edit, as an attacker would (so verifyExport passes). */
async function reseal(pkg: ExportPackage): Promise<ExportPackage> {
  const files: ExportPackage['manifest']['files'] = [];
  for (const f of pkg.manifest.files) files.push({ ...f, sha256: await sha256Hex(pkg.files[f.path]!) });
  const { packageSha256: _drop, ...rest } = { ...pkg.manifest, files };
  void _drop;
  return { manifest: { ...rest, packageSha256: await sha256Hex(canonicalJson(rest)) }, files: pkg.files };
}

/** Re-sends a captured MCP request with a (possibly altered) body through the Worker. */
async function fetchRaw(template: Request, body: string, token?: string): Promise<string> {
  const headers = Object.fromEntries(template.headers);
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await call('/mcp', { method: 'POST', headers, body: JSON.parse(body) });
  const text = await res.text();
  if (text.startsWith('event:') || text.startsWith('data:') || text.includes('\ndata:')) return text.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).at(-1)!;
  return text;
}
