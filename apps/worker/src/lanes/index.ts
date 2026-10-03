import { registerAssistant, configureAssistant, AiSearchIndex } from "@garderobe/assistant";
import { registerDaily, validateOutfit } from "@garderobe/daily";
import { CommandError, createFoundationRegistry, first, stmt, type CommandRegistry, type CommandService, type Db, type Principal } from "@garderobe/domain";
import { depsFromBindings, registerMedia, type MediaDeps } from "@garderobe/media";
import type { Env } from "../env.ts";
import { connectionAuthorization } from "../connections/service.ts";
import { listConnectionTools, outboundPorts, type OutboundDeps } from "../connections/outbound.ts";
import type { AssistantPort, DailyPort, MediaPort } from "../ports.ts";
import { recordSubmittedProposal } from "../proposals/store.ts";
import { TYPED_DIRECT_BY_OWNER_DECISION } from "../mcp/policy.ts";
import { wearsRestrictedGarment } from "../restrictions.ts";
import { createAssistantPort } from "./assistant.ts";
import { createDailyPort } from "./daily.ts";
import { createMediaPort } from "./media.ts";
import { createStudioValidator } from "./studio-validator.ts";

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
  mediaDeps ??= depsFromBindings({ DB: env.DB, MEDIA_BUCKET: env.MEDIA_BUCKET!, MEDIA_QUEUE: env.MEDIA_QUEUE as never, IMAGES: env.IMAGES as never, MEDIA_SIGNING_KEY: env.MEDIA_SIGNING_KEY! }, { validator: createStudioValidator(async () => (await import("../app.ts")).appFor(env).daily) });
  return mediaDeps;
}

/**
 * Surface guard for hard constraints. A restriction (for example "sneakers only until the toe has
 * healed") is lifted only by the owner: in the app, or in their own conversation where the assistant
 * workstream checks that the owner's words say the condition has ended. A connected assistant's request
 * carries no such verified statement (its `owner_statement` label is its own), so on the MCP channel
 * lifting is refused whichever way it is attempted, and no assistant principal on any channel may undo
 * the command that recorded a restriction. This sits on the one shared registry, so it holds for
 * `garderobe_command`, for `garderobe_ask` and `garderobe_run` (the assistant acting for an MCP
 * connection) and for the assistant in the app alike. The refusal is thrown while planning: nothing is
 * written and no receipt exists.
 */
function guardRestrictionLifts(r: CommandRegistry): void {
  // `assistant.lift_restriction` (the assistant workstream's owner-confirmed lift, when registered) is a lift too.
  for (const type of ["restriction.resolve", "assistant.lift_restriction"]) {
    if (!r.has(type)) continue;
    const resolve = r.get(type);
    const planResolve = resolve.plan;
    resolve.plan = async (ctx, payload) => {
      if (ctx.principal.channel === "mcp" || ctx.envelope.source.channel === "mcp") {
        throw new CommandError("forbidden", "a connected assistant cannot lift a restriction; the owner lifts it in the Garderobe app or in their own Garderobe conversation", { reason: "owner_statement_not_verified" });
      }
      return planResolve.call(resolve, ctx, payload);
    };
  }
  const undo = r.get("command.undo");
  const planUndo = undo.plan;
  undo.plan = async (ctx, payload) => {
    if (ctx.principal.actor !== "owner" || ctx.principal.channel === "mcp" || ctx.envelope.source.channel === "mcp") {
      const target = await first<{ type: string }>(ctx.db, "SELECT type FROM commands WHERE user_id = ? AND command_id = ?", ctx.userId, (payload as { commandId: string }).commandId);
      if (target?.type === "restriction.add") {
        throw new CommandError("forbidden", "undoing the record of a restriction would lift it; only the owner lifts a restriction, by saying its condition has ended", { reason: "restriction_not_lifted_by_undo" });
      }
    }
    return planUndo.call(undo, ctx, payload);
  };
}

/*
 * A change asked for by a connected assistant is carried out only after the signed-in owner confirms it
 * in the app (owner decision of 2026-10-01); wear and wash reports and the records of a piece of
 * research are the exceptions. A connected assistant can ask for a change as a typed `garderobe_command`
 * (see mcp/policy.ts) or through `garderobe_ask`; either way the request waits as a proposal and the
 * assistant cannot confirm it.
 */

/**
 * What Garderobe's own assistant may still commit when the text it acts on was relayed by a connected
 * assistant (`garderobe_ask`, `garderobe_research`). In the app the assistant acts on the owner's own
 * typed or spoken words; on the MCP channel the "owner's words" are whatever the connected model sent,
 * which cannot be verified as the owner's and may come from a page or a document that model read. So
 * the list is short and explicit: the records of a piece of research, and plain wear and wash reports.
 * Everything else that is not internal bookkeeping (corrections, restrictions, aliases, orders, returns,
 * reminders, briefs, settings, memory, undo, and every sensitive change above) is kept as a proposal for
 * the owner and refused. A wear report naming a garment that an active restriction excludes is treated
 * the same way: it would contradict the restriction on words nobody verified.
 */
export const RELAYED_TEXT_ALLOWED: readonly string[] = ["job.create", "job.update", "research.save_note", "product.record", "product.record_observation", "product.record_fit_assessment", "wear.record", "care.washed", "care.mark_dirty"];

type GuardContext = { db: Db; userId: string; nowMs: number; principal: Principal; envelope: { idempotencyKey: string; expectedVersions: Record<string, number>; occurredAt?: string; source: { channel?: string; parentKind?: string | null; parentId?: string | null } } };

const relayedTurn = (ctx: { principal: Principal; envelope: { source: { channel?: string; parentKind?: string | null } } }): boolean =>
  ctx.principal.actor === "assistant" && (ctx.principal.channel === "mcp" || ctx.envelope.source.channel === "mcp") && ctx.envelope.source.parentKind === "turn";

function guardRelayedText(r: CommandRegistry): void {
  const allowed = new Set(RELAYED_TEXT_ALLOWED);
  for (const type of r.types()) {
    const definition = r.get(type);
    // Internal bookkeeping (inference accounting, erasure confirmation, job progress) is not a change the text asked for.
    if (definition.class === "system") continue;
    if (allowed.has(type) && type !== "wear.record") continue;
    const plan = definition.plan;
    definition.plan = async (context, payload) => {
      const ctx = context as unknown as GuardContext;
      if (!relayedTurn(ctx)) return plan.call(definition, context, payload);
      if (type === "wear.record" && !(await wearsRestrictedGarment(ctx.db, ctx.userId, payload))) return plan.call(definition, context, payload);
      // Kept for the owner, exactly as it would run; the owner sees it in the app and decides.
      const turnId = String(ctx.envelope.source.parentId ?? "");
      let kept = false;
      if (turnId) {
        const stored = await recordSubmittedProposal(ctx.db, { userId: ctx.userId, origin: "relayed_turn", sourceRef: turnId, grantId: null, turnId, idempotencyKey: ctx.envelope.idempotencyKey, type, payload: payload as Record<string, unknown>, expectedVersions: ctx.envelope.expectedVersions ?? {}, occurredAt: ctx.envelope.occurredAt ?? null, nowMs: ctx.nowMs });
        kept = "row" in stored;
      }
      throw new CommandError("forbidden", `this cannot be changed from a message relayed by a connected assistant${kept ? "; it is kept as a proposal for the owner to confirm in the Garderobe app" : "; the owner changes it in the Garderobe app"}`, { reason: "relayed_text_not_owner_statement", proposed: kept });
    };
  }
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
    // The routine actions the owner allowed from a typed command are known to the assistant's ledger guard too.
    registerAssistant(r, { typedDirect: TYPED_DIRECT_BY_OWNER_DECISION });
    registerMedia(r, () => {
      if (!bound) throw new CommandError("internal", "the Worker bindings are not available yet");
      return mediaDepsFor(bound);
    });
    guardRestrictionLifts(r);
    guardRelayedText(r);
    // Forgetting a message also removes the requests kept from its turn: they hold the same text. Done in
    // the forgetting command's own transaction. (The owner's recorded decision holds no text and stays.)
    r.addCommitHook("api.forget_submitted_proposals", async (ctx) => {
      if (ctx.envelope.type !== "conversation.forget_source") return;
      const p = ctx.envelope.payload as { sourceKind?: string; sourceIds?: string[] };
      if (p.sourceKind !== "message" || !Array.isArray(p.sourceIds) || p.sourceIds.length === 0) return;
      return { statements: [stmt("DELETE FROM submitted_proposals WHERE user_id = ? AND turn_id IN (SELECT turn_id FROM assistant_turns WHERE user_id = ? AND user_message_id IN (SELECT value FROM json_each(?)))", ctx.userId, ctx.userId, JSON.stringify(p.sourceIds))] };
    });
    registry = r;
  }
  return registry;
}

// The conversation actor executes its commands on the same composed registry, may validate outfits and
// read decision context with the daily service, look at the owner's own photographs through the visual
// wardrobe, search the owner's own AI Search instance, and search or read the web through the owner's
// connected tool services (credentials are resolved per connection at dispatch time) and, when the
// deployment has the binding, a rendering browser.
export function assistantPortsFor(env: Env, userId: string) {
  const outbound: OutboundDeps = { db: env.DB, userId, now: () => Date.now(), browser: env.BROWSER, authorizeFor: (connectionId) => () => connectionAuthorization(env, env.DB, userId, `cred_${connectionId}`) };
  // The application is composed after this module is loaded, so it is looked up when a port is used.
  const application = async () => (await import("../app.ts")).appFor(env);
  return {
    validateOutfit: validateOutfit as never,
    searchIndex: env.AI_SEARCH ? new AiSearchIndex(env.AI_SEARCH as never, env.ENVIRONMENT ?? "dev", userId) : null,
    ...outboundPorts(outbound),
    describeConnectionTools: (principal: Principal, connectionId: string) => (principal.userId === userId ? listConnectionTools(outbound, connectionId) : Promise.resolve([])),
    decisionContext: async (principal: Principal, input: { localDate?: string; outfit: { role: string; garmentId: string }[]; role: string; tripId?: string }) => {
      const app = await application();
      if (!app.daily) throw new CommandError("precondition_failed", "the daily service is not installed in this deployment");
      return (await app.daily.decisionContext(principal, input)) as never;
    },
    ...(mediaConfigured(env)
      ? {
          openImage: async (principal: Principal, assetId: string) => {
            const app = await application();
            const image = await app.media!.openAsset(principal, assetId, { variant: "display" });
            const bytes = image.body instanceof ArrayBuffer ? new Uint8Array(image.body) : new Uint8Array(await new Response(image.body).arrayBuffer());
            return { bytes, contentType: image.contentType };
          },
        }
      : {}),
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
