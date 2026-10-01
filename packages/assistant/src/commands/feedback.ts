import { ASSISTANT_COMMANDS as C } from "@garderobe/contracts/ext/assistant";
import { CommandError, define, first, nameList, stmt, type Stmt } from "@garderobe/domain";
import { NO_UNDO, requireGarments } from "./common.ts";

const KIND_LABEL: Record<string, string> = {
  too_warm: "too warm",
  too_cold: "too cold",
  scratchy: "scratchy",
  pain: "painful",
  tight: "tight",
  loose: "loose",
  restrictive: "restrictive",
  other_discomfort: "uncomfortable",
  positive: "comfortable",
};

/**
 * One unsolicited comfort observation. It is linked only to what is actually known; missing context
 * stays null (no follow-up questionnaire). It never becomes a universal ban by itself: scope stays
 * the reported occasion unless the owner states a wider one, and a standing rule is a separate,
 * explicit direction.
 */
export const feedbackRecord = define({
  type: "feedback.record",
  schema: C["feedback.record"],
  class: "observation",
  requiredScope: "write",
  async plan(ctx, p) {
    const garments = await requireGarments(ctx, p.garmentIds);
    const feedbackId = p.feedbackId ?? ctx.newId("cfb");
    if (await first(ctx.db, "SELECT 1 AS x FROM comfort_feedback WHERE user_id = ? AND feedback_id = ?", ctx.userId, feedbackId)) {
      return { outcome: "noop", summary: "That observation was already noted", result: { feedbackId }, undo: NO_UNDO("nothing changed") };
    }
    const names = [...garments.values()].map((g) => g.name);
    const statements: Stmt[] = [
      stmt(
        "INSERT INTO comfort_feedback (user_id, feedback_id, text, kind, pain, wearing_date, activity, layer, conditions_json, scope, source_ref, status, command_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)",
        ctx.userId, feedbackId, p.text, p.kind, p.kind === "pain", p.wearingDate, p.activity, p.layer, JSON.stringify(p.conditions), p.scope, p.sourceRef, ctx.commandId, ctx.occurredAt,
      ),
      ...p.garmentIds.map((g) => stmt("INSERT INTO comfort_feedback_garments (user_id, feedback_id, garment_id) VALUES (?, ?, ?)", ctx.userId, feedbackId, g)),
    ];
    const where = p.scope ?? p.activity;
    const subject = names.length > 0 ? nameList(names) : "what you wore";
    return {
      // The owner's wording is not repeated in the receipt, so forgetting the note later leaves no copy here.
      summary: `Noted: ${subject} ${names.length > 1 ? "were" : "was"} ${KIND_LABEL[p.kind]}${where ? ` (${where})` : ""}. Applied to that context only`,
      statements,
      affected: [{ kind: "comfort_feedback", id: feedbackId, version: 1 }, ...p.garmentIds.map((g) => ({ kind: "garment_feedback", id: g, version: 1 }))],
      outbox: [{ topic: "search.index", entityKind: "comfort_feedback", entityId: feedbackId, revision: 1 }],
      result: { feedbackId, garmentIds: p.garmentIds, pain: p.kind === "pain", scope: p.scope },
      undo: { data: { feedbackId } },
    };
  },
  async planUndo(ctx, _o, data) {
    return {
      summary: "Comfort note withdrawn",
      statements: [stmt("UPDATE comfort_feedback SET status = 'retracted' WHERE user_id = ? AND feedback_id = ? AND status = 'active'", ctx.userId, data.feedbackId)],
      undo: NO_UNDO("already an undo"),
    };
  },
});

export const feedbackRetract = define({
  type: "feedback.retract",
  schema: C["feedback.retract"],
  class: "observation",
  requiredScope: "write",
  async plan(ctx, p) {
    const row = await first<{ status: string }>(ctx.db, "SELECT status FROM comfort_feedback WHERE user_id = ? AND feedback_id = ?", ctx.userId, p.feedbackId);
    if (!row) throw new CommandError("not_found", `no comfort note '${p.feedbackId}'; nothing was written`);
    if (row.status !== "active") return { outcome: "noop", summary: "That comfort note was already withdrawn", result: { feedbackId: p.feedbackId }, undo: NO_UNDO("nothing changed") };
    return {
      summary: "Comfort note withdrawn; it no longer affects suggestions",
      statements: [stmt("UPDATE comfort_feedback SET status = 'retracted' WHERE user_id = ? AND feedback_id = ?", ctx.userId, p.feedbackId)],
      affected: [{ kind: "comfort_feedback", id: p.feedbackId, version: 2 }],
      result: { feedbackId: p.feedbackId },
      undo: NO_UNDO("record the observation again to restore it"),
    };
  },
});

export const feedbackHandlers = [feedbackRecord, feedbackRetract];
