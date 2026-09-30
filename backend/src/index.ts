import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import type { Env } from './env.js';
import { ensureLaundryResets } from './domain/laundry.js';
import { systemPrincipal } from './domain/principal.js';
import { createDailyService } from './daily/runtime.js';
import { handleApp } from './api/router.js';
import { oauthProvider } from './auth/oauth.js';
import { mcpApiHandler } from './mcp/server.js';
import { handleMediaQueue } from './media/pipeline.js';

const appHandler = { fetch: handleApp } as unknown as ExportedHandler<Env>;

/**
 * Worker entry point.
 *
 * Every request goes through the Workers OAuth provider (MCP authorization, section 13): it serves
 * OAuth discovery, the token, registration and revocation endpoints, and validates bearer tokens for
 * the MCP resource `${MCP_ORIGIN}/mcp` before `mcpApiHandler` runs. Everything else (the /v1 HTTP
 * API, the web board, the consent page, /health) goes to the application router, which does its own
 * Access / native-token authentication. See backend/src/api/README.md.
 */
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return oauthProvider(env, { mcp: mcpApiHandler as never, app: appHandler }).fetch(request, env, ctx);
  },
  /** Queue consumers. garderobe-media: visual catalogue jobs (discovery, normalization, composites). */
  async queue(batch: MessageBatch<unknown>, env: Env): Promise<void> {
    if (batch.queue === 'garderobe-media' || batch.queue.startsWith('garderobe-media-')) return handleMediaQueue(batch, env);
    // No consumer here for other queues: fail the batch so messages retry instead of being dropped.
    throw new Error(`No consumer for queue ${batch.queue}`);
  },
} satisfies ExportedHandler<Env>;

/**
 * Durable Object class backing the ASSISTANT binding: the @cloudflare/think assistant, one actor per
 * internal user id (`${ENVIRONMENT}:${userId}`). Reached only through trusted backend code; see
 * src/assistant/index.ts for the interface the API/MCP layer calls.
 */
export { GarderobeAssistant } from './assistant/agent.js';

export interface DailyServiceParams {
  userId: string;
  /** ISO instant the run is evaluated at (defaults to now). */
  at?: string;
}

/**
 * Daily service workflow (spec section 9). Each step is idempotent and safe to re-run:
 *  1. apply due weekly laundry resets once per owner and cycle;
 *  2. apply pending wardrobe changes (board revalidation and Calendar re-projection effects);
 *  3. run every due phase of the owner's local schedule (evening composition, 06:40 refresh,
 *     06:50 final publication with Calendar verification), deduplicated per date and phase.
 * Trigger it from a cron or the due-job sweep with `{ userId }`; `at` pins the evaluation instant.
 */
export class DailyServiceWorkflow extends WorkflowEntrypoint<Env, DailyServiceParams> {
  override async run(event: WorkflowEvent<DailyServiceParams>, step: WorkflowStep): Promise<unknown> {
    const at = event.payload.at ?? new Date().toISOString();
    const resets = await step.do('apply weekly laundry resets', async () => {
      const applied = await ensureLaundryResets(this.env.DB, systemPrincipal(event.payload.userId), at);
      return applied.map((r) => ({ pool: r.pool, cycleKey: r.cycleKey }));
    });
    const clock = event.payload.at ? () => at : undefined;
    const effects = await step.do('apply pending wardrobe changes', async () => {
      const r = await createDailyService(this.env, event.payload.userId, { clock }).processEffects();
      return { processed: r.processed, revised: r.repaired.filter((x) => x.changed).map((x) => x.summary) };
    });
    const phases = await step.do('run due daily phases', async () => {
      const results = await createDailyService(this.env, event.payload.userId, { clock }).sweep();
      return results.map((p) => ({ phase: p.phase, boardDate: p.boardDate, status: p.status, published: p.publish?.published ?? null, deadlineMet: p.deadlineMet, error: p.error }));
    });
    return { resets, effects, phases };
  }
}
