import { ASSISTANT_COMMANDS as C } from "@garderobe/contracts/ext/assistant";
import { CommandError, all, define, first, json, stmt, type CommandContext, type Stmt } from "@garderobe/domain";
import { NO_UNDO, plural } from "./common.ts";

/**
 * A source-linked conclusion. A model extraction can only ever be a candidate: it becomes active by the
 * owner's own confirmation, the same rule as any other amendment. It is never a second inventory.
 */
export const memoryRecordConclusion = define({
  type: "memory.record_conclusion",
  schema: C["memory.record_conclusion"],
  class: "edit",
  requiredScope: "write",
  allowedAuthorizations: ["owner_tap", "owner_statement", "standing_policy", "system_schedule"],
  async plan(ctx, p) {
    const ownerAuthority = ctx.envelope.authorization === "owner_tap" || ctx.envelope.authorization === "owner_statement";
    if (p.status === "active" && (p.speaker !== "owner" || !ownerAuthority)) {
      throw new CommandError("forbidden", "only something you said yourself is remembered as settled; anything the assistant inferred stays a candidate until you confirm it");
    }
    // A forgotten source cannot be used to rebuild a memory.
    for (const id of p.sourceMessageIds) {
      if (await first(ctx.db, "SELECT 1 AS x FROM source_tombstones WHERE user_id = ? AND source_kind = 'message' AND source_id = ?", ctx.userId, id)) {
        throw new CommandError("forbidden", "one of the source messages was forgotten at your request; nothing is remembered from it");
      }
    }
    const conclusionId = p.conclusionId ?? ctx.newId("mem");
    if (await first(ctx.db, "SELECT 1 AS x FROM memory_conclusions WHERE user_id = ? AND conclusion_id = ?", ctx.userId, conclusionId)) {
      return { outcome: "noop", summary: "That conclusion is already remembered", result: { conclusionId }, undo: NO_UNDO("nothing changed") };
    }
    return {
      summary: p.status === "active" ? `Remembered (${p.kind.replace(/_/g, " ")}), linked to ${plural(p.sourceMessageIds.length, "message")}` : `Possible ${p.kind.replace(/_/g, " ")} noted for you to confirm; it is not in effect`,
      statements: [
        stmt(
          "INSERT INTO memory_conclusions (user_id, conclusion_id, version, kind, text, speaker, status, source_message_ids_json, premises_json, entity_ids_json, history_json, command_id, created_at, updated_at) VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?, '[]', ?, ?, ?)",
          ctx.userId, conclusionId, p.kind, p.text, p.speaker, p.status, JSON.stringify(p.sourceMessageIds), JSON.stringify(p.premises), JSON.stringify(p.entityIds), ctx.commandId, ctx.now, ctx.now,
        ),
      ],
      affected: [{ kind: "memory_conclusion", id: conclusionId, version: 1 }],
      outbox: p.status === "active" ? [{ topic: "search.index", entityKind: "memory_conclusion", entityId: conclusionId, revision: 1 }] : [],
      result: { conclusionId, status: p.status },
      undo: { data: { conclusionId } },
    };
  },
  async planUndo(ctx, _o, data) {
    return {
      summary: "That remembered conclusion was withdrawn",
      statements: [stmt("UPDATE memory_conclusions SET status = 'retired', version = version + 1, updated_at = ? WHERE user_id = ? AND conclusion_id = ? AND status IN ('candidate', 'active')", ctx.now, ctx.userId, data.conclusionId)],
      undo: NO_UNDO("already an undo"),
    };
  },
});

/** Confirm, retire or correct a remembered conclusion. Owner authority only. */
export const memorySetStatus = define({
  type: "memory.set_status",
  schema: C["memory.set_status"],
  class: "edit",
  requiredScope: "write",
  allowedAuthorizations: ["owner_tap", "owner_statement"],
  async plan(ctx, p) {
    const row = await first<{ version: number; status: string; text: string; history_json: string; kind: string }>(ctx.db, "SELECT version, status, text, history_json, kind FROM memory_conclusions WHERE user_id = ? AND conclusion_id = ?", ctx.userId, p.conclusionId);
    if (!row) throw new CommandError("not_found", `no remembered conclusion '${p.conclusionId}'; nothing was written`);
    if (row.status === "forgotten") throw new CommandError("forbidden", "this was forgotten at your request and cannot be restored");
    const history = json<{ version: number; text: string; status: string; at: string }[]>(row.history_json, []);
    const corrected = p.correctedText !== undefined && p.correctedText !== row.text;
    if (!corrected && row.status === p.status) return { outcome: "noop", summary: "Nothing to change", result: { conclusionId: p.conclusionId }, undo: NO_UNDO("nothing changed") };
    // A correction supersedes the earlier wording without erasing what was said historically.
    history.push({ version: row.version, text: row.text, status: corrected ? "superseded" : row.status, at: ctx.now });
    return {
      summary: corrected ? "Remembered conclusion corrected; the earlier version is kept as superseded" : p.status === "active" ? "Confirmed: this is now remembered" : "No longer remembered as current",
      statements: [
        stmt("UPDATE memory_conclusions SET version = version + 1, status = ?, text = ?, history_json = ?, updated_at = ? WHERE user_id = ? AND conclusion_id = ?", p.status, p.correctedText ?? row.text, JSON.stringify(history), ctx.now, ctx.userId, p.conclusionId),
      ],
      preconditions: [{ label: "conclusion unchanged since read", sql: "(SELECT version FROM memory_conclusions WHERE user_id = ? AND conclusion_id = ?) = ?", params: [ctx.userId, p.conclusionId, row.version], class: "internal" }],
      affected: [{ kind: "memory_conclusion", id: p.conclusionId, version: row.version + 1 }],
      outbox: [{ topic: "search.index", entityKind: "memory_conclusion", entityId: p.conclusionId, revision: row.version + 1 }],
      result: { conclusionId: p.conclusionId, status: p.status },
      undo: NO_UNDO("set the status again to change it"),
    };
  },
});

/** Stores that still hold a copy after the ledger-side erasure done inside the forget command itself. */
const PENDING_STORES: Record<string, string[]> = {
  message: ["transcript", "summaries", "ai_search"],
  memory_conclusion: ["ai_search"],
  research_note: ["ai_search"],
  comfort_feedback: ["ai_search"],
};

const FORGOTTEN = "[forgotten at the owner's request]";

async function scrubCommandPayload(ctx: CommandContext, commandId: string | null): Promise<Stmt[]> {
  if (!commandId) return [];
  // The originating command keeps its identity and receipt, but not the forgotten text.
  return [stmt("UPDATE commands SET payload_json = ? WHERE user_id = ? AND command_id = ?", JSON.stringify({ forgotten: true }), ctx.userId, commandId)];
}

/**
 * Forget sources. Inside this one commit: a tombstone per source (read-time suppression everywhere),
 * physical removal of the copies the ledger itself holds (retrieval projection, remembered conclusions
 * derived from them, note and feedback text), invalidation of summaries that covered them, and outbox
 * work for the stores that erase asynchronously. The receipt says what is erased and what is pending.
 */
export const conversationForgetSource = define({
  type: "conversation.forget_source",
  schema: C["conversation.forget_source"],
  class: "edit",
  requiredScope: "write",
  allowedAuthorizations: ["owner_tap", "owner_statement"],
  async plan(ctx, p) {
    const ids = [...new Set(p.sourceIds)];
    const statements: Stmt[] = [];
    const fresh: string[] = [];
    for (const id of ids) {
      if (await first(ctx.db, "SELECT 1 AS x FROM source_tombstones WHERE user_id = ? AND source_kind = ? AND source_id = ?", ctx.userId, p.sourceKind, id)) continue;
      fresh.push(id);
    }
    if (fresh.length === 0) return { outcome: "noop", summary: "Those were already forgotten", result: { sourceIds: ids, newlyForgotten: [] }, undo: NO_UNDO("nothing changed") };

    const pending = PENDING_STORES[p.sourceKind] ?? [];
    let invalidatedSummaries = 0;
    let derivedMemories = 0;
    for (const id of fresh) {
      statements.push(
        stmt(
          "INSERT INTO source_tombstones (user_id, source_kind, source_id, reason, requested_at, erased_stores_json, pending_stores_json, state, command_id) VALUES (?, ?, ?, ?, ?, ?, ?, 'suppressed', ?)",
          ctx.userId, p.sourceKind, id, p.reason, ctx.now, JSON.stringify(["retrieval_index", "ledger"]), JSON.stringify(pending), ctx.commandId,
        ),
      );
      if (p.sourceKind === "message") {
        statements.push(stmt("DELETE FROM conversation_judgements WHERE user_id = ? AND message_id = ?", ctx.userId, id));
        statements.push(stmt("DELETE FROM conversation_index WHERE user_id = ? AND message_id = ?", ctx.userId, id));
        // Conclusions drawn from the forgotten message go with it; otherwise the fact would return through memory.
        const derived = await all<{ conclusion_id: string; command_id: string }>(ctx.db, "SELECT conclusion_id, command_id FROM memory_conclusions m WHERE user_id = ? AND status != 'forgotten' AND EXISTS (SELECT 1 FROM json_each(m.source_message_ids_json) WHERE value = ?)", ctx.userId, id);
        for (const d of derived) {
          derivedMemories++;
          statements.push(stmt("UPDATE memory_conclusions SET status = 'forgotten', text = ?, history_json = '[]', premises_json = '[]', version = version + 1, updated_at = ? WHERE user_id = ? AND conclusion_id = ?", FORGOTTEN, ctx.now, ctx.userId, d.conclusion_id));
          statements.push(...(await scrubCommandPayload(ctx, d.command_id)));
        }
        // Summaries that covered the message are invalid now and must be regenerated without it.
        const checkpoints = await all<{ checkpoint_id: string }>(ctx.db, "SELECT checkpoint_id FROM compaction_checkpoints c WHERE user_id = ? AND status = 'active' AND EXISTS (SELECT 1 FROM json_each(c.covered_ids_json) WHERE value = ?)", ctx.userId, id);
        for (const c of checkpoints) {
          invalidatedSummaries++;
          statements.push(stmt("UPDATE compaction_checkpoints SET status = 'invalidated', invalid_reason = 'a covered source was forgotten' WHERE user_id = ? AND checkpoint_id = ?", ctx.userId, c.checkpoint_id));
        }
      } else if (p.sourceKind === "memory_conclusion") {
        const row = await first<{ command_id: string }>(ctx.db, "SELECT command_id FROM memory_conclusions WHERE user_id = ? AND conclusion_id = ?", ctx.userId, id);
        if (!row) throw new CommandError("not_found", `no remembered conclusion '${id}'; nothing was written`);
        statements.push(stmt("UPDATE memory_conclusions SET status = 'forgotten', text = ?, history_json = '[]', premises_json = '[]', version = version + 1, updated_at = ? WHERE user_id = ? AND conclusion_id = ?", FORGOTTEN, ctx.now, ctx.userId, id));
        statements.push(...(await scrubCommandPayload(ctx, row.command_id)));
      } else if (p.sourceKind === "research_note") {
        const row = await first<{ command_id: string }>(ctx.db, "SELECT command_id FROM research_notes WHERE user_id = ? AND note_id = ?", ctx.userId, id);
        if (!row) throw new CommandError("not_found", `no saved research '${id}'; nothing was written`);
        statements.push(stmt("UPDATE research_notes SET status = 'forgotten', topic = ?, body = ?, claims_json = '[]', version = version + 1, updated_at = ? WHERE user_id = ? AND note_id = ?", FORGOTTEN, FORGOTTEN, ctx.now, ctx.userId, id));
        statements.push(...(await scrubCommandPayload(ctx, row.command_id)));
      } else {
        const row = await first<{ command_id: string }>(ctx.db, "SELECT command_id FROM comfort_feedback WHERE user_id = ? AND feedback_id = ?", ctx.userId, id);
        if (!row) throw new CommandError("not_found", `no comfort note '${id}'; nothing was written`);
        statements.push(stmt("UPDATE comfort_feedback SET status = 'forgotten', text = ?, activity = NULL, conditions_json = '{}', scope = NULL WHERE user_id = ? AND feedback_id = ?", FORGOTTEN, ctx.userId, id));
        statements.push(...(await scrubCommandPayload(ctx, row.command_id)));
      }
    }
    const pendingText = pending.length > 0 ? ` Hidden everywhere now; physical removal from ${pending.join(", ").replace(/_/g, " ")} is still in progress` : " Removed";
    return {
      summary: `Forgotten: ${plural(fresh.length, p.sourceKind.replace(/_/g, " "))}.${pendingText}${derivedMemories ? `. ${plural(derivedMemories, "remembered conclusion")} drawn from them went too` : ""}${invalidatedSummaries ? `. ${plural(invalidatedSummaries, "summary", "summaries")} will be rebuilt without them` : ""}`,
      statements,
      affected: fresh.map((id) => ({ kind: `forgotten_${p.sourceKind}`, id, version: 1 })),
      outbox: [
        ...fresh.map((id) => ({ topic: "search.delete", entityKind: p.sourceKind, entityId: id, revision: 0 })),
        ...(p.sourceKind === "message" ? fresh.map((id) => ({ topic: "conversation.erase", entityKind: "message", entityId: id, revision: 0 })) : []),
        ...(invalidatedSummaries > 0 ? [{ topic: "summary.regenerate", entityKind: "conversation", entityId: ctx.userId, revision: 0 }] : []),
      ],
      result: { sourceKind: p.sourceKind, newlyForgotten: fresh, erasedStores: ["retrieval_index", "ledger"], pendingStores: pending, invalidatedSummaries, derivedMemories },
      // Forgetting is deliberately irreversible: an undo would have to resurrect the removed text.
      undo: NO_UNDO("forgetting cannot be undone"),
    };
  },
});

/** A store reports that physical removal finished. Only then does the tombstone say `erased`. */
export const conversationConfirmErasure = define({
  type: "conversation.confirm_erasure",
  schema: C["conversation.confirm_erasure"],
  class: "system",
  requiredScope: "write",
  allowedAuthorizations: ["standing_policy", "system_schedule", "owner_statement", "owner_tap"],
  async plan(ctx, p) {
    const statements: Stmt[] = [];
    let done = 0;
    for (const id of [...new Set(p.sourceIds)]) {
      const row = await first<{ erased_stores_json: string; pending_stores_json: string }>(ctx.db, "SELECT erased_stores_json, pending_stores_json FROM source_tombstones WHERE user_id = ? AND source_kind = ? AND source_id = ?", ctx.userId, p.sourceKind, id);
      if (!row) throw new CommandError("not_found", `'${id}' was never forgotten; nothing was written`);
      const erased = new Set(json<string[]>(row.erased_stores_json, []));
      const pending = json<string[]>(row.pending_stores_json, []).filter((s) => s !== p.store);
      if (p.outstandingRetention === null) erased.add(p.store);
      else if (!pending.includes(p.store)) pending.push(p.store);
      const state = pending.length === 0 ? "erased" : "suppressed";
      if (state === "erased") done++;
      statements.push(
        stmt("UPDATE source_tombstones SET erased_stores_json = ?, pending_stores_json = ?, outstanding_retention = ?, state = ? WHERE user_id = ? AND source_kind = ? AND source_id = ?", JSON.stringify([...erased]), JSON.stringify(pending), p.outstandingRetention, state, ctx.userId, p.sourceKind, id),
      );
    }
    return {
      summary: p.outstandingRetention ? `Removal from ${p.store.replace(/_/g, " ")} is delayed by provider retention: ${p.outstandingRetention}` : `Removed from ${p.store.replace(/_/g, " ")}; ${plural(done, "source")} now fully erased`,
      statements,
      result: { store: p.store, fullyErased: done },
      undo: NO_UNDO("erasure is not reversible"),
    };
  },
});

export const memoryHandlers = [memoryRecordConclusion, memorySetStatus, conversationForgetSource, conversationConfirmErasure];
