import { registerAssistant, configureAssistant, AiSearchIndex } from "@garderobe/assistant";
import { outfitValidator, registerDaily, validateOutfit } from "@garderobe/daily";
import { CommandError, createFoundationRegistry, type CommandRegistry, type CommandService, type Db } from "@garderobe/domain";
import { depsFromBindings, registerMedia, type MediaDeps } from "@garderobe/media";
import type { Env } from "../env.ts";
import { connectionAuthorization } from "../connections/service.ts";
import { outboundPorts } from "../connections/outbound.ts";
import type { AssistantPort, DailyPort, MediaPort } from "../ports.ts";
import { createAssistantPort } from "./assistant.ts";
import { createDailyPort } from "./daily.ts";
import { createMediaPort } from "./media.ts";

export interface LaneContext {
  env: Env;
  db: Db;
  registry: CommandRegistry;
  service: CommandService;
  now(): number;
}

export interface Lanes {
  daily: DailyPort | null;
  assistant: AssistantPort | null;
  media: MediaPort | null;
}

/*
 * The Worker's bindings, remembered at module level. The command registry is composed once per
 * isolate and is shared by the fetch handler, scheduled work and the conversation actor (a Durable
 * Object in the same isolate), so every surface runs the same commands and the same commit hooks.
 * Module-dependent adapters (the media bucket and signing key) are resolved from these bindings when
 * a command first needs them.
 */
let bound: Env | null = null;

export function bindEnv(env: Env): void {
  bound = env;
}

export const mediaConfigured = (env: Env): boolean => Boolean(env.MEDIA_BUCKET && env.MEDIA_SIGNING_KEY && env.MEDIA_SIGNING_KEY.length >= 32);

let mediaDeps: MediaDeps | null = null;

export function mediaDepsFor(env: Env): MediaDeps {
  if (!mediaConfigured(env)) throw new CommandError("precondition_failed", "image storage is not configured in this deployment");
  mediaDeps ??= depsFromBindings({ DB: env.DB, MEDIA_BUCKET: env.MEDIA_BUCKET!, MEDIA_QUEUE: env.MEDIA_QUEUE as never, IMAGES: env.IMAGES as never, MEDIA_SIGNING_KEY: env.MEDIA_SIGNING_KEY! }, { validator: outfitValidator as never });
  return mediaDeps;
}

let registry: CommandRegistry | null = null;

/**
 * The ONE command registry: foundation, then the daily service (boards, pause, trips and the
 * in-commit board repair hook), the assistant (purchases, returns, lifecycle, feedback, memory,
 * connections registry) and the visual wardrobe (uploads, assets, Studio).
 */
export function composedRegistry(): CommandRegistry {
  if (!registry) {
    const r = createFoundationRegistry();
    registerDaily(r);
    registerAssistant(r);
    registerMedia(r, () => {
      if (!bound) throw new CommandError("internal", "the Worker bindings are not available yet");
      return mediaDepsFor(bound);
    });
    registry = r;
  }
  return registry;
}

// The conversation actor executes its commands on the same composed registry, may validate outfits with
// the daily service, search the owner's own AI Search instance, and search or read the web through the
// owner's connected tool services (credentials are resolved per connection at dispatch time).
export function assistantPortsFor(env: Env, userId: string) {
  return {
    validateOutfit: validateOutfit as never,
    searchIndex: env.AI_SEARCH ? new AiSearchIndex(env.AI_SEARCH as never, env.ENVIRONMENT ?? "dev", userId) : null,
    ...outboundPorts({ db: env.DB, userId, now: () => Date.now(), authorizeFor: (connectionId) => () => connectionAuthorization(env, env.DB, userId, `cred_${connectionId}`) }),
  };
}

configureAssistant({
  registry: composedRegistry,
  ports: (env, userId) => assistantPortsFor(env as unknown as Env, userId),
});

/** Ports to the mounted modules. A module whose bindings are absent is reported as unavailable, never faked. */
export function mountLanes(ctx: LaneContext): Lanes {
  bindEnv(ctx.env);
  return {
    daily: createDailyPort(ctx),
    assistant: ctx.env.ASSISTANT ? createAssistantPort(ctx) : null,
    media: mediaConfigured(ctx.env) ? createMediaPort(ctx, mediaDepsFor(ctx.env)) : null,
  };
}
