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
 * Lift a restriction: resolve it and note in the profile that it has ended, in one command. There is no
 * path to this from conversation text, a connected assistant, a schedule or an import: it accepts only the
 * owner's tap in the app, and the commit hook refuses it from a turn as well.
 */
export const assistantLiftRestriction = define({
  type: "assistant.lift_restriction",
  schema: C["assistant.lift_restriction"],
  class: "edit",
  requiredScope: "write",
  allowedAuthorizations: ["owner_tap"],
  async plan(ctx, p) {
    requireOwnerTap(ctx, "lifting a restriction");
    const r = await first<{ kind: string; reason: string; status: string }>(ctx.db, "SELECT kind, reason, status FROM restrictions WHERE user_id = ? AND restriction_id = ?", ctx.userId, p.restrictionId);
    if (!r) throw new CommandError("not_found", "there is no such restriction; nothing was written", { restrictionId: p.restrictionId });
    // A request built while the restriction was active is stale once it is not.
    if (r.status !== "active") throw new CommandError("precondition_failed", "that restriction is no longer active; this request is out of date and nothing was written", { restrictionId: p.restrictionId, status: r.status });
    const source = { kind: "owner_statement" as const, ref: `command:${ctx.commandId}` };
    const resolve = await subPlan(ctx, "restriction.resolve", { restrictionId: p.restrictionId, evidence: source, note: null });
    const localDate = ctx.occurredAt.slice(0, 10);
    const reason = r.reason.replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, " ").replace(/[\u201C\u201D"]/g, "'").trim();
    const amendment = await subPlan(ctx, "style.add_amendment", {
      text: `On ${localDate} the owner confirmed in the app that the restriction "${reason}" (${r.kind}) has ended. Profile passages describing it as current no longer apply.`,
      kind: "restriction",
      source,
    });
    return mergePlans(
      {
        summary: `${resolve.summary}. Your profile now carries a dated note that it has ended`,
        result: { ...(resolve.result ?? {}), amendment: amendment.result ?? {} },
        undo: NO_UNDO("a lifted restriction is put back by stating it again, not by undo"),
      },
      [resolve, amendment],
    );
  },
});

/** The owner says an ordered piece arrived: the stock fact and the order line change together. */
export const assistantReportArrival = define({
  type: "assistant.report_arrival",
  schema: C["assistant.report_arrival"],
  class: "edit",
  requiredScope: "write",
  allowedAuthorizations: ["owner_tap"],
  async plan(ctx, p) {
    requireOwnerTap(ctx, "recording an arrival");
    const received = await subPlan(ctx, "garment.receive", { garmentId: p.garmentId });
    if (received.outcome === "noop") return received;
    const line = await first<{ order_id: string; line_id: string }>(ctx.db, "SELECT order_id, line_id FROM order_lines WHERE user_id = ? AND garment_id = ? AND state IN ('ordered', 'dispatched')", ctx.userId, p.garmentId);
    const delivered = line ? await subPlan(ctx, "purchase.mark_delivered", { orderId: line.order_id, lineId: line.line_id, deliveredOn: p.deliveredOn }) : null;
    return mergePlans(
      {
        summary: delivered ? `${received.summary}. ${delivered.summary}` : received.summary,
        result: { ...(received.result ?? {}), order: delivered?.result ?? null },
        undo: NO_UNDO("an arrival is corrected in the wardrobe record, not undone"),
      },
      delivered ? [received, delivered] : [received],
    );
  },
});

export const compositeHandlers = [assistantLiftRestriction, assistantReportArrival];
