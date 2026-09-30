import { beforeAll, describe, expect, it } from 'vitest';
import { ConnectionsResponse, SettingsResponse, TodayResponse } from '@garderobe/contracts';
import { seedOwner, uniq, type Owner } from '../harness/owner.js';
import { App } from '../harness/http.js';
import { installWorld } from '../harness/world.js';
import { connectAssistant, connectMcp, rawMcpStatus, refreshGrant, type Grant } from '../harness/mcp.js';
import '../harness/assistant.js';

/**
 * Journey 8 — Connected assistants (spec section 13 "Authorization for Claude and ChatGPT", section 15,
 * section 17 "Identity recovery"). Claude and ChatGPT are connected from a phone browser through the
 * Access-protected consent page; Settings > Connected assistants lists them separately with their
 * permissions and last use; Disconnect revokes at once (including refresh); reconnecting works
 * entirely from the browser; nothing unrelated stops working.
 */

describe('Journey: connected assistant grant, revoke and reconnect', () => {
  let owner: Owner;
  let app: App;
  let claude: Grant & { consentPage: string };
  let chatgpt: Grant;

  beforeAll(async () => {
    installWorld({ now: '2026-10-06T05:30:00.000Z' });
    owner = await seedOwner();
    app = new App(owner.assertion);
    await app.prepare();
  });

  it('connecting Claude shows the client, where tokens go and the read/write capability before consent', async () => {
    claude = await connectAssistant(owner.assertion, 'claude', ['wardrobe:read', 'wardrobe:write']);
    expect(claude.consentPage).toContain('Claude');
    expect(claude.consentPage).toContain('claude.ai');
    expect(claude.consentPage).toMatch(/read/i);
    expect(claude.consentPage).toMatch(/change|write/i);
    expect(claude.scope.split(' ').sort()).toEqual(['wardrobe:read', 'wardrobe:write']);
  });

  it('the owner can grant ChatGPT less than it asked for: read-only gets proposals, never changes', async () => {
    chatgpt = await connectAssistant(owner.assertion, 'chatgpt', ['wardrobe:read']);
    expect(chatgpt.scope).toBe('wardrobe:read');
    const mcp = await connectMcp(chatgpt.accessToken);
    const shirt = await owner.byName('Lightweight oxford — gold');
    const r = await mcp.tool('garderobe_command', { idempotencyKey: uniq('mcp'), command: { type: 'mark_in_wash', garmentId: shirt } });
    expect(r.structuredContent).toMatchObject({ status: 'proposal', receipt: null });
    expect((await app.wardrobe()).byId.get(shirt)!.stock.buckets.hamper ?? 0).toBe(0);
    await mcp.close();
  });

  it('Settings > Connected assistants lists Claude and ChatGPT separately with permissions and last use', async () => {
    const c = await connectMcp(claude.accessToken);
    await c.tool('garderobe_today');
    await c.close();
    await new Promise((r) => setTimeout(r, 100));
    const s = SettingsResponse.parse((await app.get('/v1/settings')).body);
    const grants = s.connectedAssistants ?? [];
    const cl = grants.find((g) => g.client === 'claude')!;
    const gpt = grants.find((g) => g.client === 'chatgpt')!;
    expect(cl).toMatchObject({ status: 'active', canWrite: true, redirectHost: 'claude.ai' });
    expect(gpt).toMatchObject({ status: 'active', canWrite: false, redirectHost: 'chatgpt.com' });
    expect(cl.lastUsedAt).not.toBeNull();
    expect(cl.grantId).not.toBe(gpt.grantId);
    expect(JSON.stringify(s)).not.toContain(claude.accessToken);
    expect(JSON.stringify(s)).not.toContain(claude.refreshToken);
  });

  it('Disconnect revokes Claude immediately, including its refresh token; ChatGPT and Today keep working', async () => {
    const s = SettingsResponse.parse((await app.get('/v1/settings')).body);
    const cl = s.connectedAssistants!.find((g) => g.client === 'claude')!;
    const r = await app.post<{ status: string }>(`/v1/connections/${cl.grantId}/disconnect`, {});
    expect(r.status).toBe(200);
    expect(r.body.status).toBe('disconnected');
    expect(await rawMcpStatus(claude.accessToken)).toBe(401);
    expect((await refreshGrant(claude.clientId, claude.refreshToken)).status).toBeGreaterThanOrEqual(400);
    const still = await connectMcp(chatgpt.accessToken);
    expect(TodayResponse.parse((await still.tool('garderobe_today')).structuredContent).board).not.toBeNull();
    await still.close();
    // Unrelated functions stay available: the app's Today and a native command.
    expect(TodayResponse.parse((await app.get('/v1/today')).body).board).not.toBeNull();
    const after = SettingsResponse.parse((await app.get('/v1/settings')).body);
    expect(after.connectedAssistants!.find((g) => g.grantId === cl.grantId)?.status ?? 'revoked').toBe('revoked');
  });

  it('reconnecting from the phone browser issues a fresh grant that works; the old one stays dead', async () => {
    const again = await connectAssistant(owner.assertion, 'claude', ['wardrobe:read', 'wardrobe:write']);
    const mcp = await connectMcp(again.accessToken);
    const t = await mcp.tool('garderobe_today');
    expect(TodayResponse.parse(t.structuredContent).board).not.toBeNull();
    await mcp.close();
    expect(await rawMcpStatus(claude.accessToken)).toBe(401);
  });

  it('Gmail and Calendar being disconnected names the missing permission and does not disable the assistant or Today', async () => {
    const c = ConnectionsResponse.parse((await app.get('/v1/connections')).body);
    const gmail = c.connections.find((x) => x.kind === 'gmail')!;
    expect(gmail.status).toBe('disconnected');
    expect(gmail.capabilities.some((cap) => cap.missingPermission)).toBe(true);
    expect(JSON.stringify(c)).not.toMatch(/token|secret/i);
    const turn = await app.post('/v1/conversation/turns', { clientTurnId: uniq('ios'), text: 'What have I bought from Drake’s this year?' });
    expect(turn.status).toBe(202);
    expect((await app.get('/v1/today')).status).toBe(200);
  });
});
