import { CommandService, type CommandRegistry, type Db, type Principal } from "@garderobe/domain";
import { configOf, type Config, type Env } from "./env.ts";
import { moduleUnavailable } from "./errors.ts";
import { bindEnv, composedRegistry, mountLanes } from "./lanes/index.ts";
import type { AssistantPort, DailyPort, MediaPort } from "./ports.ts";

/**
 * The composed application: ONE command registry and ONE command service shared by the HTTP API,
 * the MCP server, the assistant and scheduled work. Every surface executes the same typed commands
 * and therefore produces the same receipts and durable effects.
 */
export interface App {
  env: Env;
  config: Config;
  db: Db;
  registry: CommandRegistry;
  service: CommandService;
  daily: DailyPort | null;
  assistant: AssistantPort | null;
  media: MediaPort | null;
  now(): number;
}

const apps = new WeakMap<object, App>();

export function appFor(env: Env): App {
  const cached = apps.get(env);
  if (cached) return cached;
  const config = configOf(env);
  bindEnv(env);
  const registry = composedRegistry();
  const now = () => Date.now();
  const service = new CommandService({ db: env.DB, registry, clock: now });
  const lanes = mountLanes({ env, db: env.DB, registry, service, now });
  const app: App = { env, config, db: env.DB, registry, service, daily: lanes.daily, assistant: lanes.assistant, media: lanes.media, now };
  apps.set(env, app);
  return app;
}

export function requireDaily(app: App, what: string): DailyPort {
  if (!app.daily) throw moduleUnavailable("daily", what);
  return app.daily;
}
export function requireAssistant(app: App, what: string): AssistantPort {
  if (!app.assistant) throw moduleUnavailable("assistant", what);
  return app.assistant;
}
export function requireMedia(app: App, what: string): MediaPort {
  if (!app.media) throw moduleUnavailable("media", what);
  return app.media;
}

/** Work that follows a committed command without delaying its receipt (board refill, media job dispatch). */
export async function afterCommit(app: App, principal: Principal): Promise<void> {
  const results = await Promise.allSettled([app.daily?.afterCommit(principal), app.media?.afterCommit()]);
  for (const r of results) if (r.status === "rejected") console.warn("after-commit work failed", String((r.reason as Error)?.message ?? r.reason));
}
