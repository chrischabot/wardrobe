import { API_VERSION, CONTRACTS_VERSION, EmailSyncRequest, GarmentRole, PackingRequest, RecallSearchRequest, RunInputRequest } from '@garderobe/contracts';
import type { Env } from '../env.js';
import { requireScope, SCOPE_READ, SCOPE_WRITE } from '../domain/principal.js';
import { getReceipt } from '../domain/commands/service.js';
import { createRecallService } from '../assistant/runtime.js';
import { authenticateAccess, authenticateApp, type AppAuth } from '../auth/app.js';
import { nativeAuthorize, nativeRevoke, nativeToken } from '../auth/native.js';
import { handleAuthorize, type EnvWithOAuth } from '../auth/oauth.js';
import { renderBoardPage } from '../web/board.js';
import { answerRun } from '../mcp/pending.js';
import { apiError, errorResponse, html, HttpError, json, readForm, readJson } from './http.js';
import { buildToday } from './today.js';
import { itemDetail, parseWardrobeQuery, temperaturePreview, wardrobePage } from './wardrobe.js';
import { executeCommand, prepareBoard, receiptStatus, recommend, swapCandidates } from './operations.js';
import { conversationPage, submitTurn } from './conversation.js';
import { pendingActionForRun, runStatus, sseResponse } from './runs.js';
import { cancelRun } from './cancel.js';
import { connectionsResponse, disconnect, laundryState, receiptsPage, registerConnection, settingsResponse, styleCurrent } from './account.js';
import { authorizeUpload, completeUpload, receiveUpload, serveSignedMedia, studio, mediaFor } from './visual.js';
import { now, ownerTimezone, afterCommit } from './services.js';
import { exportData, importData, listCombinations, listComfort, listOrders, listProjects, listReturnDeadlines, listTrips, pauseState, recover, recoveryKit, runOperation, tripDetail, type TripOperation } from './surface.js';
import { accountTransfers, collectRecoveryKit, MAX_IMPORT_PACKAGE_BYTES, recoveryLinkState, recoveryStatus, sameOrigin, serveExportDownload, stagedPackage, stageImportPackage, withDeliveryLinks } from './portability.js';
import { recoveryCodePage, recoveryCollectPage, confirmDonePage, confirmPage } from '../web/account.js';
import { messagePage } from '../web/consent.js';
import { DomainError } from '../domain/errors.js';

/**
 * The native/web HTTP API (spec section 13), versioned under /v1, plus the private web board and the
 * Access-protected consent page. Every /v1 route except the public-client token endpoints and the
 * signed upload/media URLs authenticates the owner (native bearer token or Access assertion) on an
 * Access-protected hostname; the principal comes only from that authentication.
 */

type Handler = (req: Request, env: EnvWithOAuth, ctx: ExecutionContext, params: Record<string, string>, auth: AppAuth) => Promise<Response>;
type OpenHandler = (req: Request, env: EnvWithOAuth, ctx: ExecutionContext, params: Record<string, string>) => Promise<Response>;
interface Route {
  method: string;
  pattern: RegExp;
  keys: string[];
  auth: 'app' | 'access' | 'none';
  handler: Handler | OpenHandler;
}

const ID = '([a-z]{1,6}_[A-Za-z0-9_-]{1,80})';
const routes: Route[] = [];
function add(method: string, path: string, auth: Route['auth'], handler: Route['handler']): void {
  const keys: string[] = [];
  const pattern = new RegExp(`^${path.replace(/\{(\w+)\}/g, (_, k: string) => (keys.push(k), ID))}$`);
  routes.push({ method, pattern, keys, auth, handler });
}
function route(method: string, path: string, auth: 'app' | 'access', handler: Handler): void {
  add(method, path, auth, handler);
}
function open(method: string, path: string, handler: OpenHandler): void {
  add(method, path, 'none', handler);
}

const originOf = (env: Env, req: Request) => (env.APP_ORIGIN ?? new URL(req.url).origin).replace(/\/+$/, '');

// ---- session and native sign-in
route('GET', '/v1/auth/session', 'app', async (_req, _env, _ctx, _p, auth) =>
  json({ schemaVersion: CONTRACTS_VERSION, displayName: auth.displayName, authenticatedBy: auth.via, scopes: [...auth.principal.scopes], expiresAt: auth.expiresAt }),
);
route('GET', '/v1/auth/native/authorize', 'access', async (req, env, _ctx, _p, auth) => nativeAuthorize(env, req, auth));
open('POST', '/v1/auth/native/token', async (req, env) => nativeToken(env, req));
open('POST', '/v1/auth/native/revoke', async (req, env) => nativeRevoke(env, req));

// ---- today and recommendations
route('GET', '/v1/today', 'app', async (req, env, _ctx, _p, auth) => {
  const date = new URL(req.url).searchParams.get('date') ?? undefined;
  if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new HttpError(422, 'validation_failed', 'date must be YYYY-MM-DD');
  return json(await buildToday(env, auth.principal, { date, origin: originOf(env, req) }));
});
route('POST', '/v1/today/prepare', 'app', async (req, env, _ctx, _p, auth) => json(await prepareBoard(env, auth.principal, req.headers.get('content-length') === '0' ? {} : await readJson(req).catch(() => ({})))));
route('GET', '/v1/today/options/{optionId}/swaps', 'app', async (req, env, _ctx, p, auth) => {
  const role = GarmentRole.parse(new URL(req.url).searchParams.get('role'));
  return json(await swapCandidates(env, auth.principal, p.optionId!, role));
});
route('POST', '/v1/recommend', 'app', async (req, env, _ctx, _p, auth) => json(await recommend(env, auth.principal, await readJson(req))));

// ---- wardrobe
route('GET', '/v1/wardrobe', 'app', async (req, env, _ctx, _p, auth) => {
  requireScope(auth.principal, SCOPE_READ);
  return json(await wardrobePage(env, auth.principal, parseWardrobeQuery(new URL(req.url).searchParams), originOf(env, req)));
});
route('GET', '/v1/wardrobe/temperature-preview', 'app', async (req, env, _ctx, _p, auth) => {
  const t = new URL(req.url).searchParams.get('temperatureC');
  if (t === null || t.trim() === '') throw new HttpError(422, 'validation_failed', 'temperatureC is required');
  return json(await temperaturePreview(env, auth.principal, Number(t)));
});
route('GET', '/v1/items/{garmentId}', 'app', async (req, env, _ctx, p, auth) => json(await itemDetail(env, auth.principal, p.garmentId!, originOf(env, req))));
route('GET', '/v1/laundry', 'app', async (_req, env, _ctx, _p, auth) => json(await laundryState(env, auth.principal)));

// ---- commands and receipts
route('POST', '/v1/commands', 'app', async (req, env, ctx, _p, auth) => {
  const receipt = await executeCommand(env, ctx, auth.principal, await readJson(req), 'app');
  return json(receipt, receiptStatus(receipt));
});
route('GET', '/v1/commands/{commandId}', 'app', async (_req, env, _ctx, p, auth) => {
  const r = await getReceipt(env.DB, auth.principal, p.commandId!);
  if (!r) throw new HttpError(404, 'not_found', `No receipt ${p.commandId}`);
  return json(r);
});
route('GET', '/v1/receipts', 'app', async (req, env, _ctx, _p, auth) => json(await receiptsPage(env, auth.principal, new URL(req.url).searchParams)));

// ---- conversation, recall, runs
route('POST', '/v1/conversation/turns', 'app', async (req, env, _ctx, _p, auth) => {
  requireScope(auth.principal, SCOPE_WRITE);
  const { response, httpStatus } = await submitTurn(env, auth.principal, await readJson(req), { channel: 'conversation', grant: { scopes: [...auth.principal.scopes], authenticatedBy: auth.via } });
  return json(response, httpStatus);
});
route('GET', '/v1/conversation/messages', 'app', async (req, env, _ctx, _p, auth) => json(await conversationPage(env, auth.principal, new URL(req.url).searchParams)));
route('POST', '/v1/recall/search', 'app', async (req, env, _ctx, _p, auth) => {
  const body = RecallSearchRequest.parse(await readJson(req));
  const r = await createRecallService(env).search(auth.principal, { query: body.query, from: body.from, to: body.to, category: body.category, limit: body.limit, timezone: await ownerTimezone(env, auth.principal), now: now() });
  return json({ schemaVersion: CONTRACTS_VERSION, ...r });
});
route('GET', '/v1/runs/{runId}', 'app', async (_req, env, ctx, p, auth) => {
  const status = await runStatus(env.DB, auth.principal, p.runId!);
  // Commands the assistant committed during the run: apply their repair now (idempotent; no-op when nothing is pending).
  if (status.receipts?.length) await afterCommit(env, ctx, auth.principal.userId);
  return json(status);
});
route('GET', '/v1/runs/{runId}/events', 'app', async (req, env, _ctx, p, auth) => {
  await runStatus(env.DB, auth.principal, p.runId!); // 404 for another owner's run
  const url = new URL(req.url);
  const cursor = req.headers.get('last-event-id') ?? url.searchParams.get('cursor');
  const follow = url.searchParams.get('follow') !== '0';
  return sseResponse(env.DB, auth.principal, p.runId!, cursor, follow ? {} : { maxMs: 0 });
});
route('POST', '/v1/runs/{runId}/cancel', 'app', async (_req, env, ctx, p, auth) => {
  requireScope(auth.principal, SCOPE_WRITE);
  return json(await cancelRun(env, ctx, auth.principal, p.runId!));
});
route('POST', '/v1/runs/{runId}/input', 'app', async (req, env, ctx, p, auth) => {
  requireScope(auth.principal, SCOPE_WRITE);
  const body = RunInputRequest.parse(await readJson(req));
  const outcome = await answerRun(env, ctx, auth.principal, p.runId!, body.choiceId ?? null);
  if (outcome.status === 'invalid_choice') throw new HttpError(422, 'invalid_choice', outcome.message);
  // A confirmed export or recovery request: the owner's own private link, returned to the owner's own app.
  const operation = outcome.status === 'executed' && outcome.operation ? await withDeliveryLinks(env, auth.principal, outcome.operation, originOf(env, req)) : null;
  return json({ schemaVersion: CONTRACTS_VERSION, status: outcome.status, receipt: outcome.status === 'executed' ? outcome.receipt : null, ...(operation ? { operation } : {}), run: await runStatus(env.DB, auth.principal, p.runId!) });
});

// ---- uploads and media (visual wardrobe services)
route('POST', '/v1/uploads', 'app', async (req, env, _ctx, _p, auth) => authorizeUpload(env, auth.principal, req, originOf(env, req)));
open('PUT', '/v1/uploads/{uploadId}', async (req, env, _ctx, p) => receiveUpload(env, req, p.uploadId!));
route('POST', '/v1/uploads/{uploadId}/complete', 'app', async (req, env, _ctx, p, auth) => completeUpload(env, auth.principal, p.uploadId!, originOf(env, req)));
open('GET', '/v1/media/{assetId}', async (req, env, _ctx, p) => {
  const t = new URL(req.url).searchParams.get('t');
  if (t) return serveSignedMedia(env, p.assetId!, t);
  const auth = await authenticateApp(env, req);
  return mediaFor(env, auth.principal, originOf(env, req)).serve(p.assetId!);
});

// ---- studio
route('POST', '/v1/studio/choices', 'app', async (req, env, _ctx, _p, auth) => studio(env, auth.principal, 'choices', req));
route('POST', '/v1/studio/validate', 'app', async (req, env, _ctx, _p, auth) => studio(env, auth.principal, 'validate', req));
route('POST', '/v1/studio/suggest', 'app', async (req, env, _ctx, _p, auth) => studio(env, auth.principal, 'suggest', req));

// ---- settings, style, connections
route('GET', '/v1/settings', 'app', async (_req, env, _ctx, _p, auth) => json(await settingsResponse(env, auth.principal)));

// ---- trips and packing (service operations under the command policy; Idempotency-Key header)
const idemKey = (req: Request) => req.headers.get('idempotency-key');
route('GET', '/v1/trips', 'app', async (_req, env, _ctx, _p, auth) => json(await listTrips(env, auth.principal)));
route('POST', '/v1/trips', 'app', async (req, env, ctx, _p, auth) => {
  const body = (await readJson(req)) as Record<string, unknown>;
  const r = await runOperation(env, ctx, auth.principal, { ...body, type: 'create_trip' } as TripOperation, idemKey(req));
  return json({ ...r.result, replayed: r.replayed }, r.replayed ? 200 : 201);
});
route('GET', '/v1/trips/{tripId}', 'app', async (_req, env, _ctx, p, auth) => json(await tripDetail(env, auth.principal, p.tripId!)));
route('POST', '/v1/trips/{tripId}/proposal', 'app', async (req, env, ctx, p, auth) => {
  const r = await runOperation(env, ctx, auth.principal, { type: 'propose_packing', tripId: p.tripId! }, idemKey(req));
  return json(r.result);
});
for (const [path, type] of [['packed', 'mark_packed'], ['unpacked', 'mark_unpacked']] as const) {
  route('POST', `/v1/trips/{tripId}/${path}`, 'app', async (req, env, ctx, p, auth) => {
    const body = PackingRequest.parse(req.headers.get('content-length') === '0' ? {} : await readJson(req));
    const r = await runOperation(env, ctx, auth.principal, { type, tripId: p.tripId!, ...body }, idemKey(req));
    return json({ ...r.result, replayed: r.replayed });
  });
}

// ---- pause (the commands are pause_service / resume_service through POST /v1/commands)
route('GET', '/v1/service/pause', 'app', async (_req, env, _ctx, _p, auth) => json(await pauseState(env, auth.principal)));

// ---- orders, returns, email intake, comfort, lifecycle projects, saved combinations
route('GET', '/v1/orders', 'app', async (_req, env, _ctx, _p, auth) => json(await listOrders(env, auth.principal)));
route('GET', '/v1/returns', 'app', async (req, env, _ctx, _p, auth) => json(await listReturnDeadlines(env, auth.principal, new URL(req.url).searchParams)));
route('POST', '/v1/intake/email/sync', 'app', async (req, env, ctx, _p, auth) => {
  const body = EmailSyncRequest.parse(req.headers.get('content-length') === '0' ? {} : await readJson(req));
  const r = await runOperation(env, ctx, auth.principal, { type: 'sync_email', ...body }, idemKey(req));
  return json({ ...r.result, replayed: r.replayed });
});
route('GET', '/v1/comfort', 'app', async (req, env, _ctx, _p, auth) => json(await listComfort(env, auth.principal, new URL(req.url).searchParams)));
route('GET', '/v1/projects', 'app', async (_req, env, _ctx, _p, auth) => json({ schemaVersion: CONTRACTS_VERSION, projects: await listProjects(env, auth.principal) }));
route('GET', '/v1/projects/{projectId}', 'app', async (_req, env, _ctx, p, auth) => {
  const [project] = await listProjects(env, auth.principal, p.projectId!);
  if (!project) throw new HttpError(404, 'not_found', `No project ${p.projectId}`);
  return json(project);
});
route('GET', '/v1/studio/combinations', 'app', async (req, env, _ctx, _p, auth) => json(await listCombinations(env, auth.principal, new URL(req.url).searchParams)));

// ---- account recovery and portability. Locked-out recovery stays on this dedicated route; assistants
// reach export, import and recovery-kit issue only through garderobe_command with owner confirmation,
// and collect the results here, signed in (see portability.ts).
route('POST', '/v1/auth/recovery-kit', 'app', async (_req, env, _ctx, _p, auth) => json(await recoveryKit(env, auth.principal), 201));
route('GET', '/v1/auth/recovery-kit', 'app', async (_req, env, _ctx, _p, auth) => json(await recoveryStatus(env, auth.principal)));
const wantsHtml = (req: Request) => /text\/html/i.test(req.headers.get('accept') ?? '');
const pageOrError = async (req: Request, fn: () => Promise<Response>): Promise<Response> => {
  try {
    return await fn();
  } catch (err) {
    if (wantsHtml(req) && err instanceof HttpError) return html(messagePage('Recovery code', err.message), err.status);
    throw err;
  }
};
route('GET', '/v1/auth/recovery-kit/collect/{transferId}', 'app', async (req, env, _ctx, p, auth) =>
  pageOrError(req, async () => {
    const state = await recoveryLinkState(env, auth.principal, p.transferId!, new URL(req.url).searchParams.get('t'));
    return wantsHtml(req) ? html(recoveryCollectPage(auth.displayName, state.expiresAt)) : json({ schemaVersion: CONTRACTS_VERSION, transferId: p.transferId, status: 'pending', expiresAt: state.expiresAt });
  }),
);
route('POST', '/v1/auth/recovery-kit/collect/{transferId}', 'app', async (req, env, _ctx, p, auth) =>
  pageOrError(req, async () => {
    const kit = await collectRecoveryKit(env, auth.principal, auth.via, p.transferId!, new URL(req.url).searchParams.get('t'), req);
    return wantsHtml(req) ? html(recoveryCodePage(kit)) : json(kit, 201);
  }),
);
open('POST', '/v1/auth/recover', async (req, env) => json(await recover(env, req, await readJson(req))));
route('POST', '/v1/export', 'app', async (_req, env, _ctx, _p, auth) => json(await exportData(env, auth.principal)));
route('GET', '/v1/export/downloads/{transferId}', 'app', async (req, env, _ctx, p, auth) => serveExportDownload(env, auth.principal, auth.via, p.transferId!, new URL(req.url).searchParams.get('t')));
route('POST', '/v1/import', 'app', async (req, env, _ctx, _p, auth) => json(await importData(env, auth.principal, await readJson(req, 50_000_000))));
route('POST', '/v1/import/packages', 'app', async (req, env, _ctx, _p, auth) => json(await stageImportPackage(env, auth.principal, await readJson(req, MAX_IMPORT_PACKAGE_BYTES), auth.via), 201));
route('GET', '/v1/import/packages/{packageId}', 'app', async (_req, env, _ctx, p, auth) => {
  const staged = await stagedPackage(env, auth.principal, p.packageId!);
  if (!staged) throw new HttpError(404, 'not_found', `No staged import package ${p.packageId}`);
  return json(staged);
});
route('GET', '/v1/account/transfers', 'app', async (_req, env, _ctx, _p, auth) => json(await accountTransfers(env, auth.principal)));
route('GET', '/v1/style/current', 'app', async (_req, env, _ctx, _p, auth) => json(await styleCurrent(env, auth.principal)));
route('GET', '/v1/connections', 'app', async (_req, env, _ctx, _p, auth) => json(await connectionsResponse(env, auth.principal)));
route('POST', '/v1/connections', 'app', async (req, env, _ctx, _p, auth) => json(await registerConnection(env, auth.principal, await readJson(req)), 201));
route('POST', '/v1/connections/{connectionId}/disconnect', 'app', async (_req, env, _ctx, p, auth) => json(await disconnect(env, auth.principal, p.connectionId!)));

// ---- private web board
route('GET', '/board', 'access', async (req, env, _ctx, _p, auth) => {
  const date = new URL(req.url).searchParams.get('date') ?? undefined;
  if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new HttpError(422, 'validation_failed', 'date must be YYYY-MM-DD');
  return html(renderBoardPage(await buildToday(env, auth.principal, { date, origin: originOf(env, req) }), auth.displayName));
});

// ---- the owner's own confirmation of a request an assistant made (Access; the same pending record the app answers)
route('GET', '/confirm/{runId}', 'access', async (_req, env, _ctx, p, auth) => {
  const pending = await pendingActionForRun(env.DB, auth.principal.userId, p.runId!);
  if (!pending) return html(messagePage('Not found', 'There is no such request waiting for you.'), 404);
  if (pending.status !== 'pending') return html(confirmDonePage(pending.status === 'resolved' ? 'executed' : pending.status === 'cancelled' ? 'declined' : 'expired', null));
  return html(confirmPage(auth.displayName, pending.prompt, pending.expiresAt));
});
route('POST', '/confirm/{runId}', 'access', async (req, env, ctx, p, auth) => {
  if (!sameOrigin(env, req)) return html(messagePage('Not allowed', 'Confirm from Garderobe itself.'), 403);
  const decision = (await readForm(req)).get('decision');
  let outcome;
  try {
    outcome = await answerRun(env, ctx, auth.principal, p.runId!, decision === 'confirm' ? 'confirm' : null);
  } catch (err) {
    // A confirmed request the service refuses (for example an import into a Garderobe that has records).
    if (err instanceof HttpError || err instanceof DomainError) return html(messagePage('Not done', err.message), err instanceof HttpError ? err.status : 409);
    throw err;
  }
  if (outcome.status === 'invalid_choice') return html(messagePage('Choose an answer', outcome.message), 422);
  const op = outcome.status === 'executed' && outcome.operation ? await withDeliveryLinks(env, auth.principal, outcome.operation, originOf(env, req)) : null;
  const r = (op?.result ?? {}) as { downloadUrl?: string; collectUrl?: string };
  const link = r.downloadUrl ? { href: r.downloadUrl, label: 'Download your export' } : r.collectUrl ? { href: r.collectUrl, label: 'Collect your new recovery code' } : null;
  return html(confirmDonePage(outcome.status, link));
});

/** The application (non-MCP) fetch handler: the OAuth provider's default handler. */
export async function handleApp(request: Request, env: EnvWithOAuth, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);
  try {
    if (request.method === 'GET' && url.pathname === '/health') return json({ ok: true, service: 'garderobe', contractsVersion: CONTRACTS_VERSION, apiVersion: API_VERSION });
    if (url.pathname === '/authorize') return await handleAuthorize(env, request);
    let methodMismatch = false;
    for (const r of routes) {
      const m = r.pattern.exec(url.pathname);
      if (!m) continue;
      if (r.method !== request.method) {
        methodMismatch = true;
        continue;
      }
      const params = Object.fromEntries(r.keys.map((k, i) => [k, m[i + 1]!]));
      if (r.auth === 'none') return await (r.handler as OpenHandler)(request, env, ctx, params);
      const auth = r.auth === 'access' ? await authenticateAccess(env, request) : await authenticateApp(env, request);
      return await (r.handler as Handler)(request, env, ctx, params, auth);
    }
    if (methodMismatch) return apiError(405, 'method_not_allowed', `${request.method} is not supported on ${url.pathname}`);
    return apiError(404, 'not_found', `No route for ${request.method} ${url.pathname}`);
  } catch (err) {
    return errorResponse(err);
  }
}
