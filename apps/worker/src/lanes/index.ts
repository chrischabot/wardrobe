import { registerAssistant, configureAssistant, AiSearchIndex } from "@garderobe/assistant";
import { registerDaily, validateOutfit } from "@garderobe/daily";
import { CommandError, createFoundationRegistry, first, stmt, type CommandRegistry, type CommandService, type Db, type Principal } from "@garderobe/domain";
import { depsFromBindings, registerMedia, type MediaDeps } from "@garderobe/media";
import type { Env } from "../env.ts";
import { checkRemoteUrl } from "../connections/endpoints.ts";
import { connectionAuthorization } from "../connections/service.ts";
import { listConnectionTools, outboundPorts, type OutboundDeps } from "../connections/outbound.ts";
import type { AssistantPort, DailyPort, MediaPort } from "../ports.ts";
import { recordSubmittedProposal } from "../proposals/store.ts";
import { BOUND_MESSAGE, CONNECTED_BULK_LIMIT, connectedDisposition, connectedDispositionOfType } from "../mcp/policy.ts";
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

// One set of media dependencies per set of bindings (as `appFor` keeps one application per set), so a
// second set of bindings in the same isolate never gets the first one's bucket, key or daily service.
const mediaDepsByEnv = new WeakMap<object, MediaDeps>();

export function mediaDepsFor(env: Env): MediaDeps {
  if (!mediaConfigured(env)) throw new CommandError("precondition_failed", "image storage is not configured in this deployment");
  let deps = mediaDepsByEnv.get(env);
  if (!deps) {
    const forecastSource = async () => {
      const app = (await import("../app.ts")).appFor(env);
      return app.daily ? { weather: (principal: Principal, date: string | undefined) => app.daily!.weather(principal, date), now: () => app.now() } : null;
    };
    deps = depsFromBindings({ DB: env.DB, MEDIA_BUCKET: env.MEDIA_BUCKET!, MEDIA_QUEUE: env.MEDIA_QUEUE as never, IMAGES: env.IMAGES as never, MEDIA_SIGNING_KEY: env.MEDIA_SIGNING_KEY! }, { validator: createStudioValidator(forecastSource) });
    mediaDepsByEnv.set(env, deps);
  }
  return deps;
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
 * The owner's contract of 2026-10-05, "Changes apply at once with undo on every surface": a change a
 * connected assistant asks for, as a typed `garderobe_command` (mcp/policy.ts) or through `garderobe_ask`,
 * is applied at once with a receipt and an undo, except the contract's section 3 list, which waits for the
 * signed-in owner. A connected assistant can never lift a restriction or undo the record of one.
 */

/**
 * What Garderobe's own assistant may commit when the text it acts on was relayed by a connected assistant
 * (`garderobe_ask`, `garderobe_research`): the same as the typed path, decided by the same function
 * (`connectedDispositionOfType`), so the two surfaces cannot differ. Section 3 and jobs that read the owner's
 * mailbox or files are kept as a proposal for the owner and refused with `relayed_text_not_owner_statement`;
 * a change to an unbounded set is refused with `change_exceeds_bound`. Everything else goes on to the
 * assistant's own ledger hook, which applies its per-turn cap.
 */

type GuardContext = { db: Db; userId: string; nowMs: number; principal: Principal; envelope: { idempotencyKey: string; expectedVersions: Record<string, number>; occurredAt?: string; source: { channel?: string; parentKind?: string | null; parentId?: string | null } } };

const relayedTurn = (ctx: { principal: Principal; envelope: { source: { channel?: string; parentKind?: string | null } } }): boolean =>
  ctx.principal.actor === "assistant" && (ctx.principal.channel === "mcp" || ctx.envelope.source.channel === "mcp") && ctx.envelope.source.parentKind === "turn";

function guardRelayedText(r: CommandRegistry): void {
  for (const type of r.types()) {
    const definition = r.get(type);
    // Internal bookkeeping (inference accounting, erasure confirmation, job progress) is not a change the text asked for.
    if (definition.class === "system") continue;
    const plan = definition.plan;
    definition.plan = async (context, payload) => {
      const ctx = context as unknown as GuardContext;
      if (!relayedTurn(ctx)) return plan.call(definition, context, payload);
      // Lifts, internal commands and unbounded sets are refused with their own reasons; undo is judged by the command it undoes.
      const disposition = type === "command.undo" ? await connectedDisposition(r, ctx.db, ctx.userId, type, payload as Record<string, unknown>) : connectedDispositionOfType(r, type, payload as Record<string, unknown>);
      if (disposition === "lift") throw new CommandError("forbidden", "a connected assistant cannot lift a restriction or undo the command that recorded one; the owner lifts it in the Garderobe app or in their own Garderobe conversation", { reason: type === "command.undo" ? "restriction_not_lifted_by_undo" : "restriction_lift_not_relayed" });
      if (disposition === "internal") throw new CommandError("forbidden", `'${type}' is not available to a connected assistant; nothing was changed`, { reason: "not_available_to_connected_assistant" });
      if (disposition === "bounded") throw new CommandError("invalid_command", BOUND_MESSAGE, { reason: "change_exceeds_bound", limit: CONNECTED_BULK_LIMIT });
      if (disposition !== "owner") return plan.call(definition, context, payload);
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

/**
 * The address the Calendar event links to (`extensions.daily.calendar.boardBaseUrl` in the settings) is
 * written into the owner's calendar, where a calendar client makes it a link. It is therefore held to
 * the rules of any address this backend hands out: https, a named public host, no credentials, no
 * unusual port. Anything else (`javascript:`, `http:`, a file, an address literal, plain text) is
 * refused when the setting is saved, on every surface, and nothing is written. `null` or an empty
 * value clears it, and the deployment's own address is used.
 */
function guardBoardAddress(r: CommandRegistry): void {
  if (!r.has("settings.update")) return;
  const update = r.get("settings.update");
  const plan = update.plan;
  update.plan = async (ctx, payload) => {
    const calendar = (payload as { patch?: { extensions?: { daily?: { calendar?: unknown } } } }).patch?.extensions?.daily?.calendar;
    const address = calendar !== null && typeof calendar === "object" ? (calendar as { boardBaseUrl?: unknown }).boardBaseUrl : undefined;
    if (address !== undefined && address !== null && address !== "") {
      const check = typeof address === "string" ? checkRemoteUrl(address) : { ok: false, reason: "not_a_url" };
      const plain = check.ok && typeof address === "string" && new URL(address).search === "" && new URL(address).hash === "";
      if (!plain) throw new CommandError("invalid_command", "the address the Calendar event links to must be a plain https address of a public site", { field: "extensions.daily.calendar.boardBaseUrl", reason: check.ok ? "query_or_fragment" : (check.reason ?? "not_allowed") });
    }
    return plan.call(update, ctx, payload);
  };
}

const registries = new WeakMap<object, CommandRegistry>();

/**
 * The ONE command registry: foundation, then the daily service (boards, pause, trips and the
 * in-commit board repair hook), the assistant (purchases, returns, lifecycle, feedback, memory,
 * connections registry) and the visual wardrobe (uploads, assets, Studio).
 */
export function composedRegistry(env?: Env): CommandRegistry {
  // One registry per set of bindings: its media commands resolve that set's bucket, signing key and
  // database, never another environment's mounted later in the same isolate. Callers that cannot name their
  // bindings (the assistant package's default configuration) get the registry of the bindings bound last.
  const target = env ?? bound;
  if (!target) throw new CommandError("internal", "the Worker bindings are not available yet");
  let registry = registries.get(target);
  if (!registry) {
    const r = createFoundationRegistry();
    registerDaily(r);
    registerAssistant(r);
    registerMedia(r, () => mediaDepsFor(target));
    guardRestrictionLifts(r);
    guardRelayedText(r);
    guardBoardAddress(r);
    // Forgetting a message also removes the requests kept from its turn: they hold the same text. Done in
    // the forgetting command's own transaction. (The owner's recorded decision holds no text and stays.)
    r.addCommitHook("api.forget_submitted_proposals", async (ctx) => {
      if (ctx.envelope.type !== "conversation.forget_source") return;
      const p = ctx.envelope.payload as { sourceKind?: string; sourceIds?: string[] };
      if (p.sourceKind !== "message" || !Array.isArray(p.sourceIds) || p.sourceIds.length === 0) return;
      return { statements: [stmt("DELETE FROM submitted_proposals WHERE user_id = ? AND turn_id IN (SELECT turn_id FROM assistant_turns WHERE user_id = ? AND user_message_id IN (SELECT value FROM json_each(?)))", ctx.userId, ctx.userId, JSON.stringify(p.sourceIds))] };
    });
    registry = r;
    registries.set(target, r);
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
  registry: () => composedRegistry(),
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
