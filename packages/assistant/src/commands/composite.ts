/**
 * Changes that are several ledger writes but ONE command, one receipt and one confirmation.
 *
 * The owner confirms one proposal; what it does must commit together or not at all. A handler of this
 * package that needs a foundation command as part of its own change (the incoming wardrobe record of an
 * order line, the for-sale hold of a sale project, the stock movement of a project event, the profile
 * amendment of a lifted restriction) asks that command's own definition for its plan and merges it into
 * its own, so the foundation's rules and accounting run unchanged and everything lands in one batch.
 */
import { CommandError, define, first, type CommandContext, type CommandDefinition, type CommandPlan, type CommandRegistry, type StoredCommand } from "@garderobe/domain";
import { ASSISTANT_COMMANDS as C } from "@garderobe/contracts/ext/assistant";
import { NO_UNDO } from "./common.ts";
import { grantCoversTargets } from "../policy/classes.ts";
import { endedCovers, footPartsNamed } from "../policy/ended.ts";

/** The registry the lane was registered on; its foundation definitions are what sub-plans are asked from. */
let definitions: Pick<CommandRegistry, "get" | "has"> | null = null;

export function bindRegistry(registry: CommandRegistry): void {
  definitions = registry;
}

/** Ask another registered command for its plan, with its own schema applied to the payload. */
export async function subPlan(ctx: CommandContext, type: string, payload: Record<string, unknown>): Promise<CommandPlan> {
  if (!definitions || !definitions.has(type)) throw new CommandError("internal", `the command '${type}' this change depends on is not registered; nothing was written`);
  const def = definitions.get(type) as CommandDefinition;
  const parsed = def.schema.safeParse(payload);
  if (!parsed.success) throw new CommandError("invalid_command", `invalid payload for the '${type}' part of this change; nothing was written`, { issues: parsed.error.issues });
  return def.plan(ctx, parsed.data);
}

/** Ask another registered command for the plan that undoes its part of a combined change. */
export async function subUndo(ctx: CommandContext, type: string, original: StoredCommand, data: Record<string, unknown>): Promise<CommandPlan> {
  const def = definitions?.has(type) ? (definitions.get(type) as CommandDefinition) : null;
  if (!def?.planUndo) throw new CommandError("not_undoable", "part of that change cannot be undone; nothing was written");
  return def.planUndo(ctx, original, data);
}

/**
 * Merge sub-plans into a plan. Every field is carried: statements, preconditions, affected entities,
 * effects, outbox rows and repairs are concatenated; `changes` is merged field by field so the daily
 * service's repair hook sees every garment; revision bumps are OR-ed. The summary, result and undo are the
 * caller's own. Sub-plans must not touch the same garment twice (one stock planner per garment per batch).
 */
export function mergePlans(base: CommandPlan, parts: CommandPlan[], opts: { partsFirst?: boolean } = {}): CommandPlan {
  // `partsFirst`: the parts' rows are written before the caller's own (which reference them).
  const all = opts.partsFirst ? [...parts, base] : [base, ...parts];
  const changes = {
    availabilityChanged: [...new Set(all.flatMap((p) => p.changes?.availabilityChanged ?? []))],
    wears: all.flatMap((p) => p.changes?.wears ?? []),
    restrictionsChanged: all.some((p) => p.changes?.restrictionsChanged),
    styleChanged: all.some((p) => p.changes?.styleChanged),
    settingsChanged: all.some((p) => p.changes?.settingsChanged),
    laundryBaselineApplied: all.some((p) => p.changes?.laundryBaselineApplied),
  };
  return {
    ...base,
    statements: all.flatMap((p) => p.statements ?? []),
    preconditions: all.flatMap((p) => p.preconditions ?? []),
    affected: all.flatMap((p) => p.affected ?? []),
    effects: all.flatMap((p) => p.effects ?? []),
    outbox: all.flatMap((p) => p.outbox ?? []),
    repairs: all.flatMap((p) => p.repairs ?? []),
    changes,
    bumpWardrobe: all.some((p) => p.bumpWardrobe),
    bumpStyle: all.some((p) => p.bumpStyle),
  };
}

/** Only the signed-in owner, in the app or on the private web board, by their own tap. */
export function requireOwnerTap(ctx: CommandContext, what: string): void {
  const ownerInApp = ctx.principal.actor === "owner" && (ctx.principal.channel === "ios" || ctx.principal.channel === "web") && ctx.envelope.source.channel === ctx.principal.channel;
  if (!ownerInApp || ctx.envelope.authorization !== "owner_tap") {
    throw new CommandError("forbidden", `${what} is carried out only by the owner's own confirmation in the Garderobe app; nothing was written`, { reason: "owner_confirmation_required" });
  }
}

/**
 * Lift a restriction: resolve it and note in the profile that it has ended, in one command, with an undo
 * that reinstates the restriction and withdraws the note. Two ways in, both the owner's own:
 *   - the owner's tap in the app (confirming a request);
 *   - the owner's own statement in their app conversation (owner decision of 2026-10-05), where the
 *     evidence is checked against the record of that turn: its owner message is the statement, and the
 *     turn carries the `owner_direction` grant trusted code recorded when it read that the condition has
 *     ended (policy/ended.ts). A connected assistant, a schedule or an import never lifts one.
 */
export const assistantLiftRestriction = define({
  type: "assistant.lift_restriction",
  schema: C["assistant.lift_restriction"],
  class: "edit",
  requiredScope: "write",
  allowedAuthorizations: ["owner_tap", "owner_statement"],
  async plan(ctx, p) {
    const r = await first<{ kind: string; reason: string; status: string }>(ctx.db, "SELECT kind, reason, status FROM restrictions WHERE user_id = ? AND restriction_id = ?", ctx.userId, p.restrictionId);
    // The owner's statement lifts only a restriction whose condition it speaks to (policy/ended.ts), and only
    // the restriction the turn's grant was recorded for.
    const said = ctx.envelope.authorization === "owner_statement" && r && endedCovers(r) ? await ownerStatementOfTurn(ctx, "assistant.lift_restriction", p) : null;
    // The recorded sentence must speak to the same part of the foot as the restriction (policy/ended.ts).
    const statement = said && r && endedCovers(r, { parts: footPartsNamed(said.statement) }) ? said.ref : null;
    if (!statement) requireOwnerTap(ctx, "lifting a restriction");
    if (!r) throw new CommandError("not_found", "there is no such restriction; nothing was written", { restrictionId: p.restrictionId });
    // A request built while the restriction was active is stale once it is not.
    if (r.status !== "active") throw new CommandError("precondition_failed", "that restriction is no longer active; this request is out of date and nothing was written", { restrictionId: p.restrictionId, status: r.status });
    const source = { kind: "owner_statement" as const, ref: statement ?? `command:${ctx.commandId}` };
    const resolve = await subPlan(ctx, "restriction.resolve", { restrictionId: p.restrictionId, evidence: source, note: null });
    const localDate = ctx.occurredAt.slice(0, 10);
    const reason = r.reason.replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, " ").replace(/[\u201C\u201D"]/g, "'").trim();
    const amendment = await subPlan(ctx, "style.add_amendment", {
      text: `On ${localDate} the owner ${statement ? "said in conversation" : "confirmed in the app"} that the restriction "${reason}" (${r.kind}) has ended. Profile passages describing it as current no longer apply.`,
      kind: "restriction",
      source,
    });
    const resolveUndo = (resolve.undo as { data?: Record<string, unknown> } | undefined)?.data;
    const amendmentUndo = (amendment.undo as { data?: Record<string, unknown> } | undefined)?.data;
    return mergePlans(
      {
        summary: `${resolve.summary}. Your profile now carries a dated note that it has ended`,
        result: { ...(resolve.result ?? {}), amendment: amendment.result ?? {} },
        undo: resolveUndo && amendmentUndo ? { data: { resolve: resolveUndo, amendment: amendmentUndo } } : NO_UNDO("this lift was recorded without the data its undo needs"),
      },
      [resolve, amendment],
    );
  },
  async planUndo(ctx, original, data) {
    // Reinstate the restriction and withdraw the dated note, together.
    const reinstate = await subUndo(ctx, "restriction.resolve", original, data["resolve"] as Record<string, unknown>);
    const withdraw = await subUndo(ctx, "style.add_amendment", original, data["amendment"] as Record<string, unknown>);
    return mergePlans({ summary: "The restriction is in force again and the note that it had ended is withdrawn", undo: ALREADY_UNDONE }, [reinstate, withdraw]);
  },
});

/**
 * The owner says an ordered piece arrived: the stock fact and the order line change together, with an undo
 * that takes both back. From the owner's tap in the app, or from the owner's own words in a conversation
 * turn (the ledger hook checks the turn's `owner_direction` grant).
 */
export const assistantReportArrival = define({
  type: "assistant.report_arrival",
  schema: C["assistant.report_arrival"],
  class: "edit",
  requiredScope: "write",
  allowedAuthorizations: ["owner_tap", "owner_statement"],
  async plan(ctx, p) {
    const statement = ctx.envelope.authorization === "owner_statement" ? (await ownerStatementOfTurn(ctx, "assistant.report_arrival", p))?.ref ?? null : null;
    if (!statement) requireOwnerTap(ctx, "recording an arrival");
    const received = await subPlan(ctx, "garment.receive", { garmentId: p.garmentId });
    const receivedNoop = received.outcome === "noop";
    // An already received garment can still have an order line waiting for the arrival: reconcile it anyway.
    const line = await first<{ order_id: string; line_id: string }>(ctx.db, "SELECT order_id, line_id FROM order_lines WHERE user_id = ? AND garment_id = ? AND state IN ('ordered', 'dispatched')", ctx.userId, p.garmentId);
    const deliveredPlan = line ? await subPlan(ctx, "purchase.mark_delivered", { orderId: line.order_id, lineId: line.line_id, deliveredOn: p.deliveredOn }) : null;
    const delivered = deliveredPlan && deliveredPlan.outcome !== "noop" ? deliveredPlan : null;
    if (receivedNoop && !delivered) return received;
    const receiveUndo = receivedNoop ? null : (received.undo as { data?: Record<string, unknown> } | undefined)?.data;
    const deliveredUndo = delivered ? (delivered.undo as { data?: Record<string, unknown> } | undefined)?.data : null;
    const undoable = (receivedNoop || receiveUndo) && (delivered === null || deliveredUndo);
    const parts = [...(receivedNoop ? [] : [received]), ...(delivered ? [delivered] : [])];
    const summary = [receivedNoop ? null : received.summary, delivered?.summary ?? null].filter((s): s is string => !!s).join(". ");
    return mergePlans(
      {
        summary: receivedNoop ? `${summary}. The piece itself was already recorded as arrived` : summary,
        result: { ...(received.result ?? {}), order: delivered?.result ?? null },
        undo: undoable ? { data: { receive: receiveUndo ?? null, delivered: deliveredUndo ?? null } } : NO_UNDO("this arrival was recorded without the data its undo needs"),
      },
      parts,
    );
  },
  async planUndo(ctx, original, data) {
    const parts = [];
    if (data["receive"]) parts.push(await subUndo(ctx, "garment.receive", original, data["receive"] as Record<string, unknown>));
    if (data["delivered"]) parts.push(await subUndo(ctx, "purchase.mark_delivered", original, data["delivered"] as Record<string, unknown>));
    if (parts.length === 0) throw new CommandError("not_undoable", "that arrival report changed nothing that can be taken back");
    return mergePlans({ summary: data["receive"] ? "The piece is back to awaiting arrival" : "The order line is no longer marked delivered", undo: ALREADY_UNDONE }, parts);
  },
});

/** What an undo's own receipt says about undoing it again. */
const ALREADY_UNDONE = NO_UNDO("this is already an undo; repeat the original action instead");

/**
 * The reference to the owner's own statement behind a command sent from a conversation turn, or null when
 * there is none: the command must come from a turn of this owner's own app conversation (never a
 * connected assistant), that turn must carry the `owner_direction` grant trusted code recorded for this
 * type, and the grant's message must check out as the owner's message of that turn (the registered
 * verifier, the same check a restriction's evidence reference gets).
 */
async function ownerStatementOfTurn(ctx: CommandContext, type: string, payload: Record<string, unknown>): Promise<{ ref: string; statement: string } | null> {
  const source = ctx.envelope.source;
  if (ctx.principal.channel === "mcp" || source.parentKind !== "turn" || !source.parentId) return null;
  const turn = await first<{ grants_json: string }>(ctx.db, "SELECT grants_json FROM assistant_turns WHERE user_id = ? AND turn_id = ?", ctx.userId, source.parentId);
  let grants: { type?: string; basis?: string; messageId?: string; targets?: string[]; statement?: string; requestedBy?: string }[] = [];
  try {
    grants = JSON.parse(turn?.grants_json ?? "[]") as typeof grants;
  } catch {
    return null;
  }
  for (const g of grants) {
    if (g.type !== type || g.basis !== "owner_direction" || typeof g.messageId !== "string") continue;
    // Recorded for these very records (the restriction, the piece), never another.
    if (!grantCoversTargets(g, payload, type)) continue;
    const ref = `message:${g.messageId}`;
    if (await ctx.verifyOwnerStatement(ref)) {
      const statement = typeof g.statement === "string" ? g.statement : typeof g.requestedBy === "string" ? g.requestedBy : "";
      return { ref, statement };
    }
  }
  return null;
}

export const compositeHandlers = [assistantLiftRestriction, assistantReportArrival];
