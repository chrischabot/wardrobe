import { ASSISTANT_COMMANDS as C } from "@garderobe/contracts/ext/assistant";
import { CommandError, SCRUBBED_TEXT, all, define, first, json, planLedgerScrub, stmt, type CommandContext, type Stmt } from "@garderobe/domain";
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

/** Stores that erase asynchronously after the forget command itself (which removes the ledger-side copies in its own commit). */
const PENDING_STORES: Record<string, string[]> = {
  message: ["transcript", "summaries", "ai_search"],
  memory_conclusion: ["ai_search"],
  research_note: ["ai_search"],
  comfort_feedback: ["ai_search"],
};

const FORGOTTEN = SCRUBBED_TEXT;
const FORGOTTEN_JSON = JSON.stringify({ forgotten: true });
const LEDGER_HELD = "queued work of the commands that message's turn issued still needs its payload to run; it is scrubbed as soon as it has run";

/** Records the owner confirmed as records of their own: kept when the message that led to them is forgotten, and named on the receipt. */
const KEPT_ASSISTANT_RECORDS: { kind: string; label: string }[] = [
  { kind: "order", label: "order" },
  { kind: "return_case", label: "return" },
  { kind: "lifecycle_project", label: "project" },
];
const KEPT_LABEL: Record<string, string> = {
  style_document: "profile text", style_amendment: "profile amendment", style_rule: "style rule", standing_direction: "standing rule", temporary_brief: "day brief", restriction: "restriction",
  garment_fact: "garment fact", measurement: "measurement", size_experience: "size note", garment: "wardrobe record", order: "order", return_case: "return", lifecycle_project: "project",
};

const scrubMemory = (ctx: CommandContext, conclusionId: string): Stmt =>
  stmt("UPDATE memory_conclusions SET status = 'forgotten', text = ?, history_json = '[]', premises_json = '[]', entity_ids_json = '[]', version = version + 1, updated_at = ? WHERE user_id = ? AND conclusion_id = ?", FORGOTTEN, ctx.now, ctx.userId, conclusionId);

/** Everything the assistant itself wrote from a set of commands: notes, candidates, reminders, jobs. Scrubbed, not kept. */
async function scrubAssistantRecords(ctx: CommandContext, commandIds: string[], messageIds: string[]): Promise<{ statements: Stmt[]; count: number; cardMessageIds: string[]; cancelledEffectTargets: string[] }> {
  const statements: Stmt[] = [];
  const cardMessageIds: string[] = [];
  const cancelledEffectTargets: string[] = [];
  let count = 0;
  for (const commandId of commandIds) {
    statements.push(stmt("UPDATE comfort_feedback SET status = 'forgotten', text = ?, activity = NULL, layer = NULL, conditions_json = '{}', scope = NULL WHERE user_id = ? AND command_id = ?", FORGOTTEN, ctx.userId, commandId));
    statements.push(stmt("UPDATE research_notes SET status = 'forgotten', topic = ?, body = ?, claims_json = '[]', version = version + 1, updated_at = ? WHERE user_id = ? AND command_id = ?", FORGOTTEN, FORGOTTEN, ctx.now, ctx.userId, commandId));
    statements.push(stmt("UPDATE product_observations SET facts_json = '[]', missing_fields_json = '[]', return_terms = NULL WHERE user_id = ? AND command_id = ?", ctx.userId, commandId));
    statements.push(stmt("UPDATE fit_assessments SET computation_json = '{}', uncertainties_json = '[]' WHERE user_id = ? AND command_id = ?", ctx.userId, commandId));
    for (const m of await all<{ conclusion_id: string }>(ctx.db, "SELECT conclusion_id FROM memory_conclusions WHERE user_id = ? AND command_id = ? AND status != 'forgotten'", ctx.userId, commandId)) {
      statements.push(scrubMemory(ctx, m.conclusion_id));
      count++;
    }
    for (const rem of await all<{ reminder_id: string }>(ctx.db, "SELECT reminder_id FROM reminders WHERE user_id = ? AND command_id = ?", ctx.userId, commandId)) {
      statements.push(stmt("UPDATE reminders SET status = 'cancelled', title = ?, note = NULL, url = NULL, version = version + 1, updated_at = ? WHERE user_id = ? AND reminder_id = ?", FORGOTTEN, ctx.now, ctx.userId, rem.reminder_id));
      statements.push(stmt("UPDATE effects SET state = 'cancelled', payload_json = ?, updated_at = ? WHERE user_id = ? AND target_key = ? AND kind IN ('notification.reminder', 'calendar.project_reminder') AND state = 'pending'", FORGOTTEN_JSON, ctx.now, ctx.userId, `reminder:${rem.reminder_id}`));
      cancelledEffectTargets.push(`reminder:${rem.reminder_id}`);
      count++;
    }
    // A background job started from the message: its title and parameters are the request itself.
    const jobs = await all<{ job_id: string; delivery_id: string }>(ctx.db, "SELECT j.job_id, j.delivery_id FROM assistant_jobs j JOIN command_entities e ON e.user_id = j.user_id AND e.kind = 'job' AND e.entity_id = j.job_id WHERE j.user_id = ? AND e.command_id = ?", ctx.userId, commandId);
    for (const job of jobs) {
      statements.push(stmt("UPDATE assistant_jobs SET title = ?, params_json = '{}', progress_json = '{}', unresolved_reason = NULL, state = CASE WHEN state IN ('queued', 'running') THEN 'cancelled' ELSE state END, version = version + 1, updated_at = ? WHERE user_id = ? AND job_id = ?", FORGOTTEN, ctx.now, ctx.userId, job.job_id));
      // The result card the job delivered into the conversation carries the same title.
      const cards = await all<{ message_id: string }>(ctx.db, "SELECT message_id FROM assistant_deliveries WHERE user_id = ? AND substr(delivery_id, 1, ?) = ?", ctx.userId, job.delivery_id.length, job.delivery_id);
      cardMessageIds.push(...cards.map((c) => c.message_id));
      // Work that had not started is not started: the job is cancelled, so its queued run goes with it.
      statements.push(stmt("UPDATE effects SET state = 'cancelled', payload_json = ?, updated_at = ? WHERE user_id = ? AND target_key = ? AND kind = 'assistant.run_job' AND state = 'pending'", FORGOTTEN_JSON, ctx.now, ctx.userId, `job:${job.job_id}`));
      cancelledEffectTargets.push(`job:${job.job_id}`);
      count++;
    }
  }
  for (const messageId of messageIds) {
    statements.push(stmt("UPDATE products SET name = ?, maker = NULL, url = NULL, product_code = NULL, note = NULL, version = version + 1, updated_at = ? WHERE user_id = ? AND source_ref = ?", FORGOTTEN, ctx.now, ctx.userId, `message:${messageId}`));
  }
  return { statements, count, cardMessageIds, cancelledEffectTargets };
}

/** Later assistant messages that repeat what a forgotten message first said: they share at least two words that message introduced to the conversation. */
async function echoesOf(ctx: CommandContext, messageId: string): Promise<string[]> {
  const row = await first<{ position: number; terms: string; conversation_id: string }>(ctx.db, "SELECT position, terms, conversation_id FROM conversation_index WHERE user_id = ? AND message_id = ?", ctx.userId, messageId);
  if (!row) return [];
  const mine = new Set(row.terms.split(" ").filter((t) => t.length >= 5 && !t.startsWith("topic:")));
  if (mine.size === 0) return [];
  const others = await all<{ message_id: string; position: number; speaker: string; terms: string }>(ctx.db, "SELECT message_id, position, speaker, terms FROM conversation_index WHERE user_id = ? AND conversation_id = ? AND message_id != ? ORDER BY position DESC LIMIT 4000", ctx.userId, row.conversation_id, messageId);
  for (const o of others) if (o.position < row.position) for (const t of o.terms.split(" ")) mine.delete(t);
  // Words of the wardrobe's own records (names, makers, colours) are not what a message introduced.
  const records = await all<{ words: string }>(ctx.db, "SELECT lower(name || ' ' || coalesce(maker, '') || ' ' || coalesce(colour, '') || ' ' || coalesce(fabric, '') || ' ' || category) AS words FROM garments WHERE user_id = ?", ctx.userId);
  for (const r of records) for (const t of r.words.split(/[^\p{L}\p{N}]+/u)) for (const m of [...mine]) if (m === t || (t.length > 4 && (m.startsWith(t) || t.startsWith(m)))) mine.delete(m);
  if (mine.size === 0) return [];
  const need = mine.size === 1 ? 1 : 2;
  const out: string[] = [];
  for (const o of others) {
    if (o.position <= row.position || o.speaker !== "assistant") continue;
    const terms = new Set(o.terms.split(" "));
    let shared = 0;
    for (const t of mine) if (terms.has(t)) shared++;
    if (shared >= need && (need > 1 || [...mine][0]!.length >= 7)) out.push(o.message_id);
  }
  return out;
}

/**
 * Forget sources. Inside this ONE commit:
 *   - a tombstone per source (read-time suppression everywhere at once);
 *   - the turn records of a forgotten message (reply, question, proposals, refusals, receipt summaries,
 *     the record of what the owner named, the event stream);
 *   - the command ledger's own copies for every command that message's turn issued or the owner confirmed
 *     from it (the foundation's ledger scrub: request payloads, receipt prose, undo data, effect and outbox
 *     payloads, action intents, notes);
 *   - what the assistant itself wrote from it: comfort notes, research notes, product candidates,
 *     reminders, remembered conclusions, background jobs and the result cards they delivered;
 *   - later assistant messages that repeated it, and the retrieval projection of all of these;
 *   - invalidation of summaries that covered any of them.
 * Records the owner CONFIRMED as records of their own (a profile amendment, a rule, a restriction, a
 * wardrobe record, an order, a return, a project) are kept: forgetting a message never undoes what the
 * owner did. They are named in the receipt so the owner can remove them too. The transcript, summaries
 * and AI Search erase asynchronously; the receipt says so and each is confirmed separately.
 */
export const conversationForgetSource = define({
  type: "conversation.forget_source",
  schema: C["conversation.forget_source"],
  class: "edit",
  requiredScope: "write",
  allowedAuthorizations: ["owner_tap", "owner_statement"],
  async plan(ctx, p) {
    const requested = [...new Set(p.sourceIds)];
    const statements: Stmt[] = [];
    const fresh: string[] = [];
    const isFresh = async (id: string) => !(await first(ctx.db, "SELECT 1 AS x FROM source_tombstones WHERE user_id = ? AND source_kind = ? AND source_id = ?", ctx.userId, p.sourceKind, id));
    for (const id of requested) if (await isFresh(id)) fresh.push(id);
    if (fresh.length === 0) return { outcome: "noop", summary: "Those were already forgotten", result: { sourceIds: requested, newlyForgotten: [] }, undo: NO_UNDO("nothing changed") };

    const pending = [...(PENDING_STORES[p.sourceKind] ?? [])];
    let invalidatedSummaries = 0;
    let derivedMemories = 0;
    let assistantRecords = 0;
    const commandIds = new Set<string>();
    const echoes: string[] = [];
    /** The assistant's own records: applied after the ledger scrub, so a queued effect cancelled here stays cancelled and scrubbed. */
    const ownStatements: Stmt[] = [];
    const cancelledTargets: string[] = [];

    if (p.sourceKind === "message") {
      // Work list: the named messages, then the result cards and later repetitions found along the way.
      const queue = [...fresh];
      const seen = new Set(queue);
      const enqueue = async (ids: string[]) => {
        for (const id of ids) {
          if (seen.has(id) || seen.size >= 200 || !(await isFresh(id))) continue;
          seen.add(id);
          queue.push(id);
          echoes.push(id);
        }
      };
      const handle = async (id: string) => {
        const turns = await all<{ turn_id: string; user_message_id: string; reply_message_id: string | null; receipts_json: string }>(ctx.db, "SELECT turn_id, user_message_id, reply_message_id, receipts_json FROM assistant_turns WHERE user_id = ? AND (user_message_id = ? OR reply_message_id = ?)", ctx.userId, id, id);
        for (const t of turns) {
          const receipts = json<{ commandId: string; type: string; outcome: string; undoAvailable: boolean }[]>(t.receipts_json, []);
          const kept = receipts.map((r) => ({ commandId: r.commandId, type: r.type, outcome: r.outcome, summary: FORGOTTEN, undoAvailable: false }));
          const mine = t.user_message_id === id;
          statements.push(
            mine
              ? stmt("UPDATE assistant_turns SET reply_text = ?, clarification_json = NULL, proposals_json = '[]', refusals_json = '[]', grants_json = '[]', result_json = NULL, failure_json = NULL, receipts_json = ?, updated_at = ? WHERE user_id = ? AND turn_id = ?", FORGOTTEN, JSON.stringify(kept), ctx.now, ctx.userId, t.turn_id)
              : stmt("UPDATE assistant_turns SET reply_text = ?, clarification_json = NULL, result_json = NULL, failure_json = NULL, updated_at = ? WHERE user_id = ? AND turn_id = ?", FORGOTTEN, ctx.now, ctx.userId, t.turn_id),
          );
          statements.push(stmt("DELETE FROM assistant_turn_events WHERE user_id = ? AND turn_id = ?", ctx.userId, t.turn_id));
          if (!mine) continue;
          // The reply to a forgotten message goes with it.
          if (t.reply_message_id) await enqueue([t.reply_message_id]);
          // Every command that came from this turn: what the assistant recorded in it and what the owner later confirmed from it.
          // (The model service's own accounting commands hold figures, not text, and are left alone.)
          const issued = (await all<{ command_id: string; type: string }>(ctx.db, "SELECT command_id, type FROM commands WHERE user_id = ? AND json_extract(source_json, '$.parentKind') = 'turn' AND json_extract(source_json, '$.parentId') = ?", ctx.userId, t.turn_id)).filter((c) => !c.type.startsWith("inference."));
          for (const c of [...issued.map((r) => r.command_id), ...receipts.map((r) => r.commandId)]) if (c !== ctx.commandId) commandIds.add(c);
          // Intents registered for the turn that never became a command still hold the proposed effect.
          statements.push(stmt("UPDATE action_intents SET effect_json = ?, targets_json = '[]' WHERE user_id = ? AND parent_kind = 'turn' AND parent_id = ?", FORGOTTEN_JSON, ctx.userId, t.turn_id));
        }
        await enqueue(await echoesOf(ctx, id));
        // Conclusions drawn from the forgotten message go with it; otherwise the fact would return through memory.
        const derived = await all<{ conclusion_id: string; command_id: string }>(ctx.db, "SELECT conclusion_id, command_id FROM memory_conclusions m WHERE user_id = ? AND status != 'forgotten' AND EXISTS (SELECT 1 FROM json_each(m.source_message_ids_json) WHERE value = ?)", ctx.userId, id);
        for (const d of derived) {
          derivedMemories++;
          statements.push(scrubMemory(ctx, d.conclusion_id));
          if (d.command_id !== ctx.commandId) commandIds.add(d.command_id);
        }
        // Summaries that covered the message are invalid now and must be regenerated without it.
        const checkpoints = await all<{ checkpoint_id: string }>(ctx.db, "SELECT checkpoint_id FROM compaction_checkpoints c WHERE user_id = ? AND status = 'active' AND EXISTS (SELECT 1 FROM json_each(c.covered_ids_json) WHERE value = ?)", ctx.userId, id);
        for (const c of checkpoints) {
          invalidatedSummaries++;
          statements.push(stmt("UPDATE compaction_checkpoints SET status = 'invalidated', invalid_reason = 'a covered source was forgotten' WHERE user_id = ? AND checkpoint_id = ?", ctx.userId, c.checkpoint_id));
        }
        statements.push(stmt("DELETE FROM conversation_judgements WHERE user_id = ? AND message_id = ?", ctx.userId, id));
        statements.push(stmt("DELETE FROM conversation_index WHERE user_id = ? AND message_id = ?", ctx.userId, id));
      };
      let next = 0;
      const drain = async () => {
        for (; next < queue.length; next++) await handle(queue[next]!);
      };
      await drain();
      // The assistant's own records of the turn's commands; a job's result card joins the list and is handled like any other message.
      await enqueue((await scrubAssistantRecords(ctx, [...commandIds], queue)).cardMessageIds);
      await drain();
      const own = await scrubAssistantRecords(ctx, [...commandIds], queue);
      ownStatements.push(...own.statements);
      cancelledTargets.push(...own.cancelledEffectTargets);
      assistantRecords = own.count;
      fresh.splice(0, fresh.length, ...queue);
    } else {
      const table = p.sourceKind === "memory_conclusion" ? { name: "memory_conclusions", id: "conclusion_id", what: "remembered conclusion" } : p.sourceKind === "research_note" ? { name: "research_notes", id: "note_id", what: "saved research" } : { name: "comfort_feedback", id: "feedback_id", what: "comfort note" };
      for (const id of fresh) {
        const row = await first<{ command_id: string }>(ctx.db, `SELECT command_id FROM ${table.name} WHERE user_id = ? AND ${table.id} = ?`, ctx.userId, id);
        if (!row) throw new CommandError("not_found", `no ${table.what} '${id}'; nothing was written`);
        if (p.sourceKind === "memory_conclusion") statements.push(scrubMemory(ctx, id));
        else if (p.sourceKind === "research_note") statements.push(stmt("UPDATE research_notes SET status = 'forgotten', topic = ?, body = ?, claims_json = '[]', version = version + 1, updated_at = ? WHERE user_id = ? AND note_id = ?", FORGOTTEN, FORGOTTEN, ctx.now, ctx.userId, id));
        else statements.push(stmt("UPDATE comfort_feedback SET status = 'forgotten', text = ?, activity = NULL, layer = NULL, conditions_json = '{}', scope = NULL WHERE user_id = ? AND feedback_id = ?", FORGOTTEN, ctx.userId, id));
        if (row.command_id !== ctx.commandId) commandIds.add(row.command_id);
      }
    }

    // The command ledger's own copies, scrubbed in this same commit by the foundation's ledger scrub.
    const scrub = await planLedgerScrub({ db: ctx.db, userId: ctx.userId, now: ctx.now, commandId: ctx.commandId }, [...commandIds]);
    statements.push(...scrub.statements, ...ownStatements);
    // Queued work this forgetting itself cancels is not "still pending": it will never run.
    const cancelledEffects = new Set<string>();
    for (const target of cancelledTargets) for (const e of await all<{ effect_id: string }>(ctx.db, "SELECT effect_id FROM effects WHERE user_id = ? AND target_key = ? AND state = 'pending'", ctx.userId, target)) cancelledEffects.add(e.effect_id);
    const stillQueued = scrub.pendingEffects.filter((e) => !cancelledEffects.has(e.effectId));
    // Records the owner confirmed are kept: named, not silently left.
    const kept: { kind: string; id: string }[] = scrub.retained.map((r) => ({ kind: r.kind, id: r.id }));
    if (p.sourceKind === "message" && scrub.scrubbedCommandIds.length > 0) {
      const marks = scrub.scrubbedCommandIds.map(() => "?").join(",");
      for (const k of [...KEPT_ASSISTANT_RECORDS, { kind: "garment", label: "wardrobe record" }]) {
        const rows = await all<{ entity_id: string }>(ctx.db, `SELECT DISTINCT e.entity_id FROM command_entities e JOIN commands c ON c.user_id = e.user_id AND c.command_id = e.command_id WHERE e.user_id = ? AND e.kind = ? AND c.authorization_basis = 'owner_tap' AND e.command_id IN (${marks})`, ctx.userId, k.kind, ...scrub.scrubbedCommandIds);
        for (const r of rows) kept.push({ kind: k.kind, id: r.entity_id });
      }
    }
    const ledgerErased = stillQueued.length === 0 && scrub.pendingOutbox === 0;
    if (!ledgerErased) pending.push("ledger");
    const erased = ledgerErased ? ["retrieval_index", "ledger"] : ["retrieval_index"];
    for (const id of fresh) {
      statements.push(
        stmt(
          "INSERT INTO source_tombstones (user_id, source_kind, source_id, reason, requested_at, erased_stores_json, pending_stores_json, outstanding_retention, state, command_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'suppressed', ?)",
          ctx.userId, p.sourceKind, id, null, ctx.now, JSON.stringify(erased), JSON.stringify(pending), ledgerErased ? null : LEDGER_HELD, ctx.commandId,
        ),
      );
    }

    const keptCounts = new Map<string, number>();
    for (const k of kept) keptCounts.set(KEPT_LABEL[k.kind] ?? k.kind.replace(/_/g, " "), (keptCounts.get(KEPT_LABEL[k.kind] ?? k.kind.replace(/_/g, " ")) ?? 0) + 1);
    const removedNow = ["recall", "the turn records", ...(scrub.counts.commands > 0 ? [`the ledger's copies for ${plural(scrub.counts.commands, "change")}`] : []), ...(assistantRecords + derivedMemories > 0 ? [`${plural(assistantRecords + derivedMemories, "note, reminder or remembered conclusion", "notes, reminders or remembered conclusions")} written from ${fresh.length === 1 ? "it" : "them"}`] : [])];
    const named = requested.filter((id) => fresh.includes(id)).length;
    const sentences = [
      `Forgotten: ${plural(named, p.sourceKind.replace(/_/g, " "))}${echoes.length > 0 ? ` and ${plural(echoes.length, "later reply or result card", "later replies or result cards")} that repeated ${named === 1 ? "it" : "them"}` : ""}`,
      `Removed now from ${removedNow.join(", ")}`,
      `Still being removed from ${pending.join(", ").replace(/_/g, " ")}; hidden there meanwhile, and each is confirmed when it is done`,
      ...(kept.length > 0 ? [`Kept, because you confirmed them as records of your own: ${[...keptCounts].map(([label, n]) => plural(n, label)).join(", ")}. Remove them in the app if they should go too`] : []),
      ...(invalidatedSummaries ? [`${plural(invalidatedSummaries, "summary", "summaries")} will be rebuilt without ${named === 1 ? "it" : "them"}`] : []),
    ];
    return {
      summary: sentences.join(". "),
      statements,
      affected: fresh.map((id) => ({ kind: `forgotten_${p.sourceKind}`, id, version: 1 })),
      outbox: [
        ...fresh.map((id) => ({ topic: "search.delete", entityKind: p.sourceKind, entityId: id, revision: 0 })),
        ...(p.sourceKind === "message" ? fresh.map((id) => ({ topic: "conversation.erase", entityKind: "message", entityId: id, revision: 0 })) : []),
        ...(invalidatedSummaries > 0 ? [{ topic: "summary.regenerate", entityKind: "conversation", entityId: ctx.userId, revision: 0 }] : []),
      ],
      result: { sourceKind: p.sourceKind, newlyForgotten: fresh, alsoForgotten: echoes, erasedStores: erased, pendingStores: pending, invalidatedSummaries, derivedMemories, assistantRecords, scrubbedCommands: scrub.counts.commands, pendingEffects: stillQueued.length, pendingOutbox: scrub.pendingOutbox, kept },
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
    let retention = p.outstandingRetention;
    if (p.store === "ledger") {
      // The ledger is confirmed by doing the work: queued effects and outbox rows that still held their
      // payload when the message was forgotten are scrubbed now if they have run. Never taken on trust.
      const forgetting = await all<{ command_id: string }>(ctx.db, `SELECT DISTINCT command_id FROM source_tombstones WHERE user_id = ? AND source_kind = ? AND source_id IN (${p.sourceIds.map(() => "?").join(",")})`, ctx.userId, p.sourceKind, ...p.sourceIds);
      const scrubbed: string[] = [];
      for (const f of forgetting) scrubbed.push(...(await all<{ command_id: string }>(ctx.db, "SELECT command_id FROM commands WHERE user_id = ? AND scrubbed_by_command_id = ?", ctx.userId, f.command_id)).map((r) => r.command_id));
      const again = await planLedgerScrub({ db: ctx.db, userId: ctx.userId, now: ctx.now, commandId: ctx.commandId }, scrubbed);
      statements.push(...again.statements);
      retention = again.ledgerCopiesErased ? null : LEDGER_HELD;
    }
    for (const id of [...new Set(p.sourceIds)]) {
      const row = await first<{ erased_stores_json: string; pending_stores_json: string; outstanding_retention: string | null }>(ctx.db, "SELECT erased_stores_json, pending_stores_json, outstanding_retention FROM source_tombstones WHERE user_id = ? AND source_kind = ? AND source_id = ?", ctx.userId, p.sourceKind, id);
      if (!row) throw new CommandError("not_found", `'${id}' was never forgotten; nothing was written`);
      const erased = new Set(json<string[]>(row.erased_stores_json, []));
      const pending = json<string[]>(row.pending_stores_json, []).filter((s) => s !== p.store);
      if (retention === null) erased.add(p.store);
      else if (!pending.includes(p.store)) pending.push(p.store);
      const state = pending.length === 0 ? "erased" : "suppressed";
      if (state === "erased") done++;
      statements.push(
        stmt("UPDATE source_tombstones SET erased_stores_json = ?, pending_stores_json = ?, outstanding_retention = ?, state = ? WHERE user_id = ? AND source_kind = ? AND source_id = ?", JSON.stringify([...erased]), JSON.stringify(pending), retention ?? (pending.length > 0 && !(p.store === "ai_search" && row.outstanding_retention !== LEDGER_HELD) ? row.outstanding_retention : null), state, ctx.userId, p.sourceKind, id),
      );
    }
    return {
      summary: retention ? `Removal from ${p.store.replace(/_/g, " ")} is not finished: ${retention}` : `Removed from ${p.store.replace(/_/g, " ")}; ${plural(done, "source")} now fully erased`,
      statements,
      result: { store: p.store, fullyErased: done },
      undo: NO_UNDO("erasure is not reversible"),
    };
  },
});

export const memoryHandlers = [memoryRecordConclusion, memorySetStatus, conversationForgetSource, conversationConfirmErasure];
