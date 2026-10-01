/**
 * The Garderobe Worker entry.
 *
 * One Worker serves two trust domains (specification section 15):
 *  - the app/API hostname, behind Cloudflare Access: `/v1/*`, `/auth/*`, `/board`, the MCP consent
 *    page, and the provider callback (authenticated by its own one-time state);
 *  - the MCP hostname, under the Workers OAuth provider: discovery, token, registration, revocation
 *    and the MCP transport at `/mcp`.
 * Every request enters through the OAuth provider, which answers its own protocol endpoints, hands
 * token-bearing `/mcp` requests to the protected MCP handler and everything else to the application
 * router. The router refuses Access-trust routes on any hostname other than the app hostname.
 */
import { appFor } from "./app.ts";
import { configOf, type Env } from "./env.ts";
import { errorResponse, json } from "./http.ts";
import { oauthProviderFor } from "./mcp/handler.ts";
import { appRouter } from "./routes/index.ts";
import { sweepExpired } from "./maintenance.ts";
import { resumeErasures } from "./identity/erasure.ts";
import { runScheduledBackups } from "./backup/service.ts";
import { deliverNotifications } from "./notifications/service.ts";
import { GarderobeAssistant as AssistantActor } from "@garderobe/assistant";
import { bindEnv } from "./lanes/index.ts";

/**
 * The conversation actor (Think Durable Object, binding `ASSISTANT`). It is the assistant
 * workstream's class; this subclass only hands the Worker's bindings to the shared composition so the
 * actor executes commands on the same registry as every other surface.
 */
export class GarderobeAssistant extends AssistantActor {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx as never, env as never);
    bindEnv(env);
  }
}

async function applicationFetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const app = appFor(env);
  const response = await appRouter().handle(app, request, ctx);
  if (response) return response;
  return json({ error: { code: "not_found", message: "no such route", details: {} } }, 404);
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    try {
      configOf(env);
    } catch (error) {
      console.error(String((error as Error).message));
      return errorResponse(error);
    }
    return oauthProviderFor(env, applicationFetch).fetch(request, env, ctx);
  },

  /** Cron: the daily service's due phases and calendar projections, media and assistant maintenance, and expiry sweeps. */
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    const app = appFor(env);
    const nowMs = app.now();
    const jobs: Promise<unknown>[] = [sweepExpired(app, nowMs), oauthProviderFor(env, applicationFetch).purgeExpiredData(env), resumeErasures(app, nowMs), runScheduledBackups(app, nowMs)];
    if (app.daily) jobs.push(app.daily.scheduled(nowMs));
    if (app.media) jobs.push(app.media.scheduled(nowMs));
    if (app.assistant) jobs.push(app.assistant.maintenance(nowMs));
    // After the daily phases above have queued this sweep's reminders, due notifications are sent.
    ctx.waitUntil(
      Promise.allSettled(jobs)
        .then(() => deliverNotifications(app, app.now()))
        .catch((error) => console.error("notification delivery failed", String((error as Error)?.message ?? error))),
    );
    ctx.waitUntil(
      Promise.allSettled(jobs).then((results) => {
        for (const r of results) if (r.status === "rejected") console.error("scheduled work failed", String((r.reason as Error)?.message ?? r.reason));
      }),
    );
  },

  async queue(batch: MessageBatch<unknown>, env: Env): Promise<void> {
    const app = appFor(env);
    if (app.media) await app.media.queue(batch);
  },
} satisfies ExportedHandler<Env>;
