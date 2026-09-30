import {
  CONTRACTS_VERSION,
  CommandEnvelope,
  PrepareBoardRequest,
  type BoardDocument,
  type CommandReceipt,
  type GarmentRole,
  type PrepareBoardResponse,
  type SourceChannel,
} from '@garderobe/contracts';
import { z } from 'zod';
import type { Env } from '../env.js';
import { CommandService } from '../domain/commands/service.js';
import { DomainError } from '../domain/errors.js';
import { findForgedOwnerFields, requireScope, SCOPE_READ, SCOPE_WRITE, type Principal } from '../domain/principal.js';
import { buildDocument, whySentence } from '../recommend/document.js';
import { getDailyBoard } from '../recommend/publish.js';
import { loadTripCovering } from '../trips/store.js';
import { HttpError } from './http.js';
import { afterCommit, now, ownerToday, recommendationService } from './services.js';
import { studioFor } from './visual.js';
import { applyServiceEffects } from './service-effects.js';

/**
 * Operations shared by the HTTP API and the MCP server, so both surfaces run exactly the same
 * checks: one command service, one idempotency namespace, one recommendation validator.
 */

/** Channels each surface may claim. The channel is metadata; ownership always comes from the principal. */
export const SURFACE_SOURCES: Record<'app' | 'web' | 'mcp', SourceChannel[]> = {
  app: ['app', 'offline_replay'],
  web: ['web'],
  mcp: ['mcp'],
};

export async function executeCommand(env: Env, ctx: ExecutionContext | undefined, principal: Principal, raw: unknown, surface: 'app' | 'web' | 'mcp'): Promise<CommandReceipt> {
  const forged = findForgedOwnerFields(raw);
  if (forged.length) throw new DomainError('forbidden_owner_field', 'Owner identity comes from the authenticated connection', { fields: forged });
  const source = (raw as { source?: unknown } | null)?.source;
  if (typeof source === 'string' && !SURFACE_SOURCES[surface].includes(source as SourceChannel)) {
    throw new HttpError(422, 'validation_failed', `source must be one of ${SURFACE_SOURCES[surface].join(', ')} on this surface`);
  }
  const receipt = await new CommandService(env.DB, principal, { now }).execute(await checkedPlan(env, principal, raw));
  if ((receipt.outcome === 'committed' || receipt.outcome === 'merged') && !receipt.replayed) {
    await applyServiceEffects(env, principal, receipt).catch((err: unknown) => console.warn('pause effects deferred', err instanceof Error ? err.message : String(err)));
    await afterCommit(env, ctx, principal.userId);
  }
  return receipt;
}

/**
 * Plan for a day must pass the day's validation (weather, cleanliness, the owner's hard rules) before
 * it is stored; the plan_outfit handler itself checks only ownership and structure. A replay of an
 * already-stored key is returned as it was.
 */
async function checkedPlan(env: Env, principal: Principal, raw: unknown): Promise<unknown> {
  const env0 = raw as { idempotencyKey?: unknown; command?: { type?: unknown; date?: unknown; slots?: unknown } } | null;
  if (env0?.command?.type !== 'plan_outfit' || typeof env0.idempotencyKey !== 'string') return raw;
  const stored = await env.DB.prepare('SELECT 1 AS x FROM command_receipts WHERE user_id = ? AND idempotency_key = ?').bind(principal.userId, env0.idempotencyKey).first();
  if (stored) return raw;
  const validation = await studioFor(env, principal).validate({ mode: 'today', date: env0.command.date, slots: env0.command.slots });
  if (!validation.valid) {
    throw new HttpError(422, 'plan_invalid_for_day', `This combination does not work for ${String(env0.command.date)}: ${validation.issues.map((i) => i.message).join('; ')}`, { validation });
  }
  return raw;
}

/** HTTP status for a receipt; the body is always the structured receipt. */
export function receiptStatus(r: CommandReceipt): number {
  if (r.outcome === 'committed' || r.outcome === 'merged') return r.replayed ? 200 : 201;
  if (r.outcome === 'conflict') return 409;
  const code = r.error?.code ?? '';
  if (code === 'insufficient_scope') return 403;
  if (code === 'not_found') return 404;
  if (code === 'idempotency_key_reused') return 409;
  if (code === 'forbidden_owner_field') return 400;
  return 422;
}

export const RecommendInput = z.strictObject({
  date: z.iso.date().optional(),
  count: z.number().int().min(1).max(10).optional(),
  brief: z.string().max(2000).optional(),
  occasion: z.enum(['formal', 'travel', 'dinner', 'outdoor']).optional(),
  include: z.array(z.string().min(3).max(80)).max(10).optional(),
  exclude: z.array(z.string().min(3).max(80)).max(30).optional(),
});
export type RecommendInput = z.infer<typeof RecommendInput>;

export interface RecommendResult {
  schemaVersion: typeof CONTRACTS_VERSION;
  date: string;
  /** Validated preview options. The prepared daily board is not changed by a recommendation request. */
  document: BoardDocument;
  options: { optionId: string; position: number; slots: { garmentId: string; name: string; role: GarmentRole; alternativeGroup: string | null }[]; why: string; valid: true; jointAvailability: number }[];
  shortfall: string | null;
  preparedBoard: { boardId: string; revision: number } | null;
}

/** garderobe_recommend and the app's "more like this": validated options for a brief, date and count. */
export async function recommend(env: Env, principal: Principal, raw: unknown): Promise<RecommendResult> {
  requireScope(principal, SCOPE_READ);
  const input = RecommendInput.parse(raw ?? {});
  const date = input.date ?? (await ownerToday(env, principal)).date;
  const rec = recommendationService(env, principal);
  const { context, composed } = await rec.compose({ date, requestedCount: input.count ?? null, briefText: input.brief ?? null, include: input.include, exclude: input.exclude, occasion: input.occasion ?? null, wholeBoardOccasion: Boolean(input.occasion) });
  const options = composed.options.map((o, i) => ({ optionId: `prv_${date.replace(/-/g, '')}_${i + 1}`, position: i + 1, status: 'offerable' as const, scored: o, why: whySentence(o, context) }));
  const document = buildDocument(context, { options, shortfall: composed.shortfall, suitableCount: composed.suitableCount, prose: 'deterministic' });
  const board = await getDailyBoard(env.DB, principal, date, 'day');
  return {
    schemaVersion: CONTRACTS_VERSION,
    date,
    document,
    options: options.map((o) => ({
      optionId: o.optionId,
      position: o.position,
      slots: o.scored.slots.map((s) => ({ garmentId: s.garmentId, name: context.byId.get(s.garmentId)?.name ?? s.garmentId, role: s.role, alternativeGroup: s.alternativeGroup ?? null })),
      why: o.why,
      valid: true as const,
      jointAvailability: o.scored.joint,
    })),
    shortfall: composed.shortfall,
    preparedBoard: board ? { boardId: board.boardId, revision: board.currentRevision } : null,
  };
}

/** POST /v1/today/prepare: compose, validate and publish the day's board now (owner's explicit request). On a trip day it is the trip-day board. */
export async function prepareBoard(env: Env, principal: Principal, raw: unknown): Promise<PrepareBoardResponse> {
  requireScope(principal, SCOPE_WRITE);
  const input = PrepareBoardRequest.parse(raw ?? {});
  const date = input.date ?? (await ownerToday(env, principal)).date;
  const trip = await loadTripCovering(env.DB, principal.userId, date);
  const purpose = trip ? `trip:${trip.tripId}` : 'day';
  const out = await recommendationService(env, principal).composeAndPublish({ date, purpose, requestedCount: input.count ?? null });
  return { published: out.published, reason: out.reason, revision: out.board?.currentRevision ?? null, shortfall: out.shortfall, purpose, date };
}

export interface SwapCandidates {
  schemaVersion: typeof CONTRACTS_VERSION;
  optionId: string;
  role: GarmentRole;
  candidates: { garmentId: string; name: string; reason: string }[];
  validatedAt: string;
}

/** GET /v1/today/options/{optionId}/swaps?role=: validated alternatives for one piece (reads only). */
export async function swapCandidates(env: Env, principal: Principal, optionId: string, role: GarmentRole, limit = 8): Promise<SwapCandidates> {
  requireScope(principal, SCOPE_READ);
  const { date } = await ownerToday(env, principal);
  // The daily service owns the Swap list: validated as a swap (profile rule 6, never a navy fallback)
  // and never a shirt or trousers already used by another option of the board.
  const { candidates } = await recommendationService(env, principal).swapCandidates({ boardDate: date, optionId, role, limit });
  return { schemaVersion: CONTRACTS_VERSION, optionId, role, candidates, validatedAt: now() };
}

export { CommandEnvelope };
