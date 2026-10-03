/**
 * Background duties of the assistant, for the Worker's scheduled sweep or queue consumer. Idempotent and
 * safe to run repeatedly: every step is keyed by a durable ID and re-reads current state.
 *   - job completions are delivered to the owner's conversation as one settled result card each;
 *   - physical erasure of forgotten sources is reconciled (transcript, summaries, AI Search);
 *   - the retrieval index and, when bound, the AI Search projection are caught up from their watermarks;
 *   - model-call reservations whose outcome is not known are reconciled against the provider's record.
 */
import { acknowledgeOutbox, all, first, json, readOutbox, systemPrincipalFor, type CommandService, type Db } from "@garderobe/domain";
import { assistantClient } from "./client.ts";
import type { SearchIndexPort } from "./recall/ai-search.ts";
import { runSearchProjection } from "./recall/projection.ts";
import { reconcileInferenceReservations, type ProviderUsageLookup, type ReconcileResult } from "./inference/reconcile.ts";

export interface MaintenanceDeps {
  db: Db;
  service: CommandService;
  env: { ASSISTANT: DurableObjectNamespace<any> };
  gatewayId: string;
  nowMs: number;
  searchIndexFor?: (userId: string) => SearchIndexPort | null;
  /** The provider's record of model calls (AI Gateway logs). Absent: uncertain reservations stay uncertain. */
  usageLookup?: ProviderUsageLookup | null;
}

export interface MaintenanceResult {
  delivered: number;
  erasuresReconciled: number;
  searchUploaded: number;
  searchRemoved: number;
  skippedOwners: string[];
  /** Model-call reservations: abandoned ones recorded as uncertain, and uncertain ones closed on the provider's record. */
  reservations: ReconcileResult;
}

export async function runAssistantMaintenance(deps: MaintenanceDeps, opts: { limit?: number } = {}): Promise<MaintenanceResult> {
  const result: MaintenanceResult = { delivered: 0, erasuresReconciled: 0, searchUploaded: 0, searchRemoved: 0, skippedOwners: [], reservations: { markedUncertain: 0, settled: 0, released: 0, stillUncertain: 0, lookupFailures: 0, notLookedUp: 0 } };
  const pending = await readOutbox(deps.db, { topics: ["conversation.deliver", "conversation.erase", "summary.regenerate", "search.index", "search.delete", "garment"], limit: opts.limit ?? 200 });
  const owners = [...new Set(pending.map((e) => e.userId))];
  for (const userId of owners) {
    // Ownership and account status are rechecked before a background result enters a conversation.
    let principal;
    try {
      principal = await systemPrincipalFor(deps.db, userId, "assistant-maintenance", "system");
    } catch {
      result.skippedOwners.push(userId);
      continue;
    }
    const client = assistantClient(deps.env, principal);
    const done: number[] = [];
    for (const entry of pending.filter((e) => e.userId === userId)) {
      if (entry.topic === "conversation.deliver") {
        const job = await first<{ title: string; state: string; coverage_json: string | null; unresolved_reason: string | null; result_ref: string | null; committed_command_ids_json: string; delivery_id: string }>(
          deps.db,
          "SELECT title, state, coverage_json, unresolved_reason, result_ref, committed_command_ids_json, delivery_id FROM assistant_jobs WHERE user_id = ? AND job_id = ?",
          userId,
          entry.entityId,
        );
        if (job) {
          const coverage = json<{ from: string | null; to: string | null; completion: string } | null>(job.coverage_json, null);
          const committed = json<string[]>(job.committed_command_ids_json, []);
          // The card is built from the job ledger by trusted code; it starts no inference turn.
          const lines = [
            job.state === "completed" ? "Finished." : job.state === "cancelled" ? "Stopped." : "Could not finish.",
            coverage ? `Searched ${coverage.from ?? "the beginning"} to ${coverage.to ?? "now"}: ${coverage.completion === "complete" ? "complete" : "partial, not everything was searched"}.` : "",
            job.unresolved_reason ? `Unresolved: ${job.unresolved_reason}` : "",
            committed.length > 0 ? `${committed.length} change(s) were recorded and remain in place.` : "",
          ].filter(Boolean);
          const delivery = await client.deliverResult({ deliveryId: job.delivery_id, title: job.title, body: lines.join(" "), refs: [{ kind: "job", id: entry.entityId }, ...(job.result_ref ? [{ kind: "result", id: job.result_ref }] : [])] });
          if (delivery.delivered) result.delivered++;
        }
        // Acknowledged only after the conversation durably accepted the deduplicated card.
        done.push(entry.seq);
      } else if (entry.topic === "conversation.erase" || entry.topic === "summary.regenerate") {
        const erased = await client.reconcileErasures();
        result.erasuresReconciled += erased.erased.length;
        const rebuilt = await client.rebuildSanitizedSession();
        // A rebuild deferred because a turn is running is retried on the next sweep.
        if (rebuilt.rebuilt || rebuilt.reason === "nothing to remove") done.push(entry.seq);
      }
    }
    if (done.length > 0) await acknowledgeOutbox(deps.db, done, deps.nowMs);
    // Ledger copies that could not be scrubbed when a source was forgotten (queued work still needed its
    // payload) are finished here once that work has run.
    const ledgerHeld = (await all<{ source_kind: string; source_id: string; pending_stores_json: string }>(deps.db, "SELECT source_kind, source_id, pending_stores_json FROM source_tombstones WHERE user_id = ? AND state = 'suppressed'", userId)).filter((h) => json<string[]>(h.pending_stores_json, []).includes("ledger"));
    for (const kind of [...new Set(ledgerHeld.map((h) => h.source_kind))]) {
      const ids = ledgerHeld.filter((h) => h.source_kind === kind).map((h) => h.source_id).slice(0, 200);
      await deps.service.execute(principal, { type: "conversation.confirm_erasure", payload: { sourceKind: kind, sourceIds: ids, store: "ledger", outstandingRetention: null }, idempotencyKey: `erasure:ledger:${kind}:${ids[0]}:${ids.length}:${deps.nowMs}`, authorization: "system_schedule", source: { channel: "system" } });
    }
    await client.projectIndex();
    const index = deps.searchIndexFor?.(userId) ?? null;
    if (index) {
      const projected = await runSearchProjection(deps.db, deps.service, index, { userId, nowMs: deps.nowMs, gatewayId: deps.gatewayId });
      result.searchUploaded += projected.uploaded;
      result.searchRemoved += projected.removed;
      if (projected.removed > 0) {
        // AI Search has confirmed removal: only now is that store reported as erased.
        const held = await all<{ source_kind: string; source_id: string; pending_stores_json: string }>(deps.db, "SELECT source_kind, source_id, pending_stores_json FROM source_tombstones WHERE user_id = ? AND state = 'suppressed'", userId);
        for (const kind of [...new Set(held.map((h) => h.source_kind))]) {
          const ids = held.filter((h) => h.source_kind === kind && json<string[]>(h.pending_stores_json, []).includes("ai_search")).map((h) => h.source_id);
          const remaining = (await readOutbox(deps.db, { topics: ["search.delete"], limit: 500 })).filter((e) => e.userId === userId).map((e) => e.entityId);
          const confirmed = ids.filter((id) => !remaining.includes(id));
          if (confirmed.length > 0) {
            await deps.service.execute(principal, { type: "conversation.confirm_erasure", payload: { sourceKind: kind, sourceIds: confirmed.slice(0, 200), store: "ai_search", outstandingRetention: null }, idempotencyKey: `erasure:ai_search:${kind}:${confirmed[0]}:${confirmed.length}`, authorization: "system_schedule", source: { channel: "system" } });
          }
        }
      }
    }
  }
  // Independent of the outbox: an open reservation belongs to an owner who may have nothing else pending.
  result.reservations = await reconcileInferenceReservations({ db: deps.db, service: deps.service, nowMs: deps.nowMs, usageLookup: deps.usageLookup ?? null });
  return result;
}
