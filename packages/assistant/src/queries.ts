/** Owner-qualified reads for the API/MCP workstream and for the assistant's own tools. All take `(db, principal, ...)`. */
import type {
  ComfortFeedback,
  Connection,
  ForgetState,
  InferenceOverview,
  InferenceTask,
  BudgetClass,
  Job,
  LifecycleProject,
  MemoryConclusion,
  Order,
  ReturnCase,
  ReturnTerms,
} from "@garderobe/contracts/ext/assistant";
import { all, assertPrincipal, first, getSettings, json, localDateOf, requireScope, type Db, type Principal } from "@garderobe/domain";
import { refundStateOf } from "./commands/returns.ts";
import { DEFAULT_DAILY_BUDGETS, PROFILE_SPECS, TASK_SPECS, toModelProfile, type ProbeRow } from "./inference/registry.ts";

function guard(principal: Principal): string {
  assertPrincipal(principal);
  requireScope(principal, "read");
  return principal.userId;
}

export async function listOrders(db: Db, principal: Principal, opts: { merchantKey?: string; limit?: number } = {}): Promise<Order[]> {
  const userId = guard(principal);
  const rows = opts.merchantKey
    ? await all<any>(db, "SELECT * FROM orders WHERE user_id = ? AND merchant_key = ? ORDER BY COALESCE(ordered_on, created_at) DESC LIMIT ?", userId, opts.merchantKey, opts.limit ?? 100)
    : await all<any>(db, "SELECT * FROM orders WHERE user_id = ? ORDER BY COALESCE(ordered_on, created_at) DESC LIMIT ?", userId, opts.limit ?? 100);
  const out: Order[] = [];
  for (const r of rows) out.push(await hydrateOrder(db, userId, r));
  return out;
}

export async function getOrder(db: Db, principal: Principal, orderId: string): Promise<Order | null> {
  const userId = guard(principal);
  const row = await first<any>(db, "SELECT * FROM orders WHERE user_id = ? AND order_id = ?", userId, orderId);
  return row ? hydrateOrder(db, userId, row) : null;
}

async function hydrateOrder(db: Db, userId: string, r: any): Promise<Order> {
  const lines = await all<any>(db, "SELECT * FROM order_lines WHERE user_id = ? AND order_id = ? ORDER BY line_id", userId, r.order_id);
  const events = await all<any>(db, "SELECT * FROM order_events WHERE user_id = ? AND order_id = ? ORDER BY occurred_at, event_id", userId, r.order_id);
  return {
    orderId: r.order_id,
    version: r.version,
    merchant: r.merchant,
    merchantKey: r.merchant_key,
    orderNumber: r.order_number,
    orderedOn: r.ordered_on,
    currency: r.currency,
    totalMinor: r.total_minor,
    channel: r.channel,
    replacesOrderId: r.replaces_order_id,
    lines: lines.map((l) => ({
      lineId: l.line_id,
      lineKey: l.line_key,
      productName: l.product_name,
      productCode: l.product_code,
      fabricCode: l.fabric_code,
      size: l.size,
      colour: l.colour,
      fitOptions: json(l.fit_options_json, {}),
      priceMinor: l.price_minor,
      currency: l.currency,
      quantity: l.quantity,
      arrivalEstimate: l.arrival_estimate,
      state: l.state,
      garmentId: l.garment_id,
      deliveredOn: l.delivered_on,
      refundedMinor: l.refunded_minor,
      replaces: l.replaces_order_id && l.replaces_line_id ? { orderId: l.replaces_order_id, lineId: l.replaces_line_id } : null,
    })),
    events: events.map((e) => ({ eventId: e.event_id, kind: e.kind, occurredAt: e.occurred_at, sourceRef: e.source_ref, lineIds: json(e.line_ids_json, []), amountMinor: e.amount_minor })),
    sourceRefs: json(r.source_refs_json, []),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export async function listReturnCases(db: Db, principal: Principal, opts: { open?: boolean } = {}): Promise<ReturnCase[]> {
  const userId = guard(principal);
  const rows = await all<any>(db, `SELECT * FROM return_cases WHERE user_id = ? ${opts.open ? "AND state NOT IN ('refunded', 'exchanged', 'closed', 'cancelled')" : ""} ORDER BY COALESCE(deadline_at, '9999') ASC, created_at DESC`, userId);
  const out: ReturnCase[] = [];
  for (const r of rows) {
    // Stock has departed only when the ledger recorded the physical departure.
    const departed = r.garment_id ? await first<{ n: number }>(db, "SELECT COALESCE(SUM(quantity), 0) AS n FROM stock_balances WHERE user_id = ? AND garment_id = ? AND bucket = 'gone'", userId, r.garment_id) : null;
    out.push({
      caseId: r.case_id,
      version: r.version,
      kind: r.kind,
      state: r.state,
      orderId: r.order_id,
      lineId: r.line_id,
      garmentId: r.garment_id,
      quantity: r.quantity,
      terms: json<ReturnTerms | null>(r.terms_json, null),
      triggerDate: r.trigger_date,
      deadline: { status: r.deadline_status, at: r.deadline_at, localDate: r.deadline_local_date, timezone: r.deadline_status === "established" ? r.deadline_timezone : null, concerns: r.deadline_concerns, reason: r.deadline_reason },
      nextAction: r.next_action,
      labelRef: r.label_ref,
      collectionPreference: r.collection_preference,
      shipmentRef: r.shipment_ref,
      retailerReceivedOn: r.retailer_received_on,
      refund: { expectedMinor: r.refund_expected_minor, receivedMinor: r.refund_received_minor, state: refundStateOf(r.refund_expected_minor, r.refund_received_minor), currency: r.currency },
      exchangeIncoming: r.exchange_order_id && r.exchange_line_id ? { orderId: r.exchange_order_id, lineId: r.exchange_line_id } : null,
      stockDeparted: (departed?.n ?? 0) > 0,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    });
  }
  return out;
}

export async function listLifecycleProjects(db: Db, principal: Principal, opts: { open?: boolean } = {}): Promise<LifecycleProject[]> {
  const userId = guard(principal);
  const rows = await all<any>(db, `SELECT * FROM lifecycle_projects WHERE user_id = ? ${opts.open ? "AND state NOT IN ('completed', 'cancelled')" : ""} ORDER BY updated_at DESC`, userId);
  const out: LifecycleProject[] = [];
  for (const r of rows) {
    const items = await all<any>(db, "SELECT * FROM lifecycle_project_items WHERE user_id = ? AND project_id = ? ORDER BY garment_id", userId, r.project_id);
    const events = await all<any>(db, "SELECT e.* FROM lifecycle_events e JOIN commands c ON c.user_id = e.user_id AND c.command_id = e.command_id WHERE e.user_id = ? AND e.project_id = ? ORDER BY e.occurred_at, c.rowid", userId, r.project_id);
    out.push({
      projectId: r.project_id,
      version: r.version,
      kind: r.kind,
      state: r.state,
      title: r.title,
      destination: r.destination,
      nextAction: r.next_action,
      details: json(r.details_json, {}),
      items: items.map((i) => ({ garmentId: i.garment_id, quantity: i.quantity, state: i.state, proceedsMinor: i.proceeds_minor, currency: i.currency })),
      authorizations: json<any[]>(r.authorizations_json, []).map((a) => ({ action: a.action, scope: a.scope, grantedAt: a.grantedAt })),
      events: events.map((e) => ({ eventId: e.event_id, kind: e.kind, detail: json(e.detail_json, {}), occurredAt: e.occurred_at })),
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    });
  }
  return out;
}

export async function listComfortFeedback(db: Db, principal: Principal, opts: { garmentIds?: string[]; includeRetracted?: boolean } = {}): Promise<ComfortFeedback[]> {
  const userId = guard(principal);
  const rows = await all<any>(db, `SELECT * FROM comfort_feedback WHERE user_id = ? AND status ${opts.includeRetracted ? "!= 'forgotten'" : "= 'active'"} ORDER BY created_at DESC`, userId);
  const links = await all<{ feedback_id: string; garment_id: string }>(db, "SELECT feedback_id, garment_id FROM comfort_feedback_garments WHERE user_id = ?", userId);
  const want = opts.garmentIds ? new Set(opts.garmentIds) : null;
  return rows
    .map((r) => ({
      feedbackId: r.feedback_id,
      text: r.text,
      kind: r.kind,
      pain: r.pain === 1,
      garmentIds: links.filter((l) => l.feedback_id === r.feedback_id).map((l) => l.garment_id),
      wearingDate: r.wearing_date,
      activity: r.activity,
      layer: r.layer,
      conditions: json(r.conditions_json, {}),
      scope: r.scope,
      status: r.status,
      createdAt: r.created_at,
    }))
    .filter((f) => !want || f.garmentIds.some((g) => want.has(g)));
}

export async function listMemoryConclusions(db: Db, principal: Principal, opts: { statuses?: string[] } = {}): Promise<MemoryConclusion[]> {
  const userId = guard(principal);
  const statuses = opts.statuses ?? ["candidate", "active"];
  const rows = await all<any>(db, `SELECT * FROM memory_conclusions WHERE user_id = ? AND status IN (${statuses.map(() => "?").join(",")}) ORDER BY created_at DESC`, userId, ...statuses);
  return rows.map((r) => ({
    conclusionId: r.conclusion_id,
    version: r.version,
    kind: r.kind,
    text: r.text,
    speaker: r.speaker,
    status: r.status,
    sourceMessageIds: json(r.source_message_ids_json, []),
    premises: json(r.premises_json, []),
    entityIds: json(r.entity_ids_json, []),
    createdAt: r.created_at,
  }));
}

export interface ResearchNote {
  noteId: string;
  version: number;
  topic: string;
  body: string;
  claims: { text: string; status: string; support: { url: string; passage: string; date: string | null; sourceClass: string }[]; uncertainty: string | null }[];
  garmentIds: string[];
  productIds: string[];
  createdAt: string;
}

export async function listResearchNotes(db: Db, principal: Principal, opts: { query?: string } = {}): Promise<ResearchNote[]> {
  const userId = guard(principal);
  const rows = await all<any>(db, "SELECT * FROM research_notes WHERE user_id = ? AND status = 'active' ORDER BY updated_at DESC", userId);
  const q = opts.query?.toLowerCase();
  return rows
    .filter((r) => !q || `${r.topic}\n${r.body}`.toLowerCase().includes(q))
    .map((r) => ({ noteId: r.note_id, version: r.version, topic: r.topic, body: r.body, claims: json(r.claims_json, []), garmentIds: json(r.garment_ids_json, []), productIds: json(r.product_ids_json, []), createdAt: r.created_at }));
}

export interface ProductView {
  productId: string;
  name: string;
  maker: string | null;
  url: string | null;
  productCode: string | null;
  note: string | null;
  /** Always false: a shopping candidate is never owned stock. */
  owned: false;
  observations: { observationId: string; observedAt: string; checkedUrl: string; availability: string; size: string | null; colour: string | null; priceMinor: number | null; currency: string | null; method: string; completeness: string; facts: unknown[]; missingFields: string[]; returnTerms: string | null }[];
  fitAssessments: { assessmentId: string; sizeLabel: string | null; verdict: string; computation: Record<string, unknown>; uncertainties: string[]; createdAt: string }[];
}

export async function listProducts(db: Db, principal: Principal): Promise<ProductView[]> {
  const userId = guard(principal);
  const rows = await all<any>(db, "SELECT * FROM products WHERE user_id = ? ORDER BY updated_at DESC", userId);
  const out: ProductView[] = [];
  for (const r of rows) {
    const obs = await all<any>(db, "SELECT * FROM product_observations WHERE user_id = ? AND product_id = ? ORDER BY observed_at DESC", userId, r.product_id);
    const fits = await all<any>(db, "SELECT * FROM fit_assessments WHERE user_id = ? AND product_id = ? ORDER BY created_at DESC", userId, r.product_id);
    out.push({
      productId: r.product_id,
      name: r.name,
      maker: r.maker,
      url: r.url,
      productCode: r.product_code,
      note: r.note,
      owned: false,
      observations: obs.map((o) => ({ observationId: o.observation_id, observedAt: o.observed_at, checkedUrl: o.checked_url, availability: o.availability, size: o.size, colour: o.colour, priceMinor: o.price_minor, currency: o.currency, method: o.method, completeness: o.completeness, facts: json(o.facts_json, []), missingFields: json(o.missing_fields_json, []), returnTerms: o.return_terms })),
      fitAssessments: fits.map((f) => ({ assessmentId: f.assessment_id, sizeLabel: f.size_label, verdict: f.verdict, computation: json(f.computation_json, {}), uncertainties: json(f.uncertainties_json, []), createdAt: f.created_at })),
    });
  }
  return out;
}

export async function listConnections(db: Db, principal: Principal): Promise<Connection[]> {
  const userId = guard(principal);
  const rows = await all<any>(db, "SELECT * FROM connections WHERE user_id = ? ORDER BY created_at", userId);
  return rows.map((r) => ({
    connectionId: r.connection_id,
    version: r.version,
    kind: r.kind,
    label: r.label,
    endpoint: r.endpoint,
    namespace: r.namespace,
    secretRef: r.secret_ref,
    scopes: json(r.scopes_json, []),
    status: r.status,
    protocolVersion: r.protocol_version,
    schemaDigest: r.schema_digest,
    tools: json(r.tools_json, []),
    enabledGroups: json(r.enabled_groups_json, []),
    lastDiscoveryAt: r.last_discovery_at,
  }));
}

export async function listJobs(db: Db, principal: Principal, opts: { states?: string[] } = {}): Promise<Job[]> {
  const userId = guard(principal);
  const rows = await all<any>(db, "SELECT j.*, d.delivered_at FROM assistant_jobs j LEFT JOIN assistant_deliveries d ON d.user_id = j.user_id AND d.delivery_id = j.delivery_id WHERE j.user_id = ? ORDER BY j.priority, j.created_at", userId);
  return rows
    .filter((r) => !opts.states || opts.states.includes(r.state))
    .map((r) => ({
      jobId: r.job_id,
      version: r.version,
      kind: r.kind,
      state: r.state,
      title: r.title,
      params: json(r.params_json, {}),
      priority: r.priority,
      progress: json(r.progress_json, {}),
      coverage: json(r.coverage_json, null),
      resultRef: r.result_ref,
      unresolvedReason: r.unresolved_reason,
      committedCommandIds: json(r.committed_command_ids_json, []),
      deliveryId: r.delivery_id,
      deliveredAt: r.delivered_at ?? null,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }));
}

export async function listForgetStates(db: Db, principal: Principal): Promise<ForgetState[]> {
  const userId = guard(principal);
  const rows = await all<any>(db, "SELECT * FROM source_tombstones WHERE user_id = ? ORDER BY requested_at DESC", userId);
  return rows.map((r) => ({ sourceKind: r.source_kind, sourceId: r.source_id, state: r.state, requestedAt: r.requested_at, erasedStores: json(r.erased_stores_json, []), pendingStores: json(r.pending_stores_json, []), outstandingRetention: r.outstanding_retention }));
}

/** IDs suppressed by a forget request, for read-time filtering in the transcript, model context and recall. */
export async function tombstonedIds(db: Db, userId: string, sourceKind: string): Promise<Set<string>> {
  const rows = await all<{ source_id: string }>(db, "SELECT source_id FROM source_tombstones WHERE user_id = ? AND source_kind = ?", userId, sourceKind);
  return new Set(rows.map((r) => r.source_id));
}

/** Model selection as the app shows it: profiles with their probe state, task routing, budgets and breakers. */
export async function getInferenceOverview(db: Db, principal: Principal, opts: { gatewayId: string | null; nowMs?: number }): Promise<InferenceOverview> {
  const userId = guard(principal);
  const probes = opts.gatewayId ? await all<ProbeRow>(db, "SELECT profile_id, operation, result, billing, reason, resolved_model, probed_at FROM model_probes WHERE gateway_id = ?", opts.gatewayId) : [];
  const routingRows = await all<{ task: string; profile_id: string; fallbacks_json: string }>(db, "SELECT task, profile_id, fallbacks_json FROM inference_routing WHERE user_id = ?", userId);
  const { settings } = await getSettings(db, principal);
  const budgetDay = localDateOf(opts.nowMs ?? Date.now(), settings.timezone);
  const custom = ((settings.extensions["assistant"] as { budgets?: Record<string, number> } | undefined)?.budgets ?? {}) as Record<string, number>;
  const usage = await all<{ budget_class: string; state: string; reserved: number; actual: number }>(
    db,
    "SELECT budget_class, state, SUM(reserved_microusd) AS reserved, SUM(actual_microusd) AS actual FROM inference_reservations WHERE user_id = ? AND budget_day = ? GROUP BY budget_class, state",
    userId,
    budgetDay,
  );
  const breakers = opts.gatewayId ? await all<any>(db, "SELECT profile_id, state, failures, opened_at FROM model_breakers WHERE gateway_id = ?", opts.gatewayId) : [];
  return {
    gatewayId: opts.gatewayId,
    profiles: PROFILE_SPECS.map((spec) => toModelProfile(spec, probes, [])),
    routing: (Object.keys(TASK_SPECS) as InferenceTask[]).map((task) => {
      const chosen = routingRows.find((r) => r.task === task);
      const spec = TASK_SPECS[task];
      return { task, profileId: chosen?.profile_id ?? spec.candidates[0] ?? null, fallbacks: chosen ? json<string[]>(chosen.fallbacks_json, []) : spec.candidates.slice(1), budgetClass: spec.budgetClass };
    }),
    budgets: (Object.keys(DEFAULT_DAILY_BUDGETS) as BudgetClass[]).map((budgetClass) => {
      const of = (state: string, field: "reserved" | "actual") => usage.filter((u) => u.budget_class === budgetClass && u.state === state).reduce((n, u) => n + (u[field] ?? 0), 0);
      return { budgetClass, dailyLimitMicroUsd: custom[budgetClass] ?? DEFAULT_DAILY_BUDGETS[budgetClass], reservedMicroUsd: of("reserved", "reserved"), settledMicroUsd: of("settled", "actual"), uncertainMicroUsd: of("uncertain", "reserved"), budgetDay };
    }),
    breakers: breakers.map((b) => ({ profileId: b.profile_id, state: b.state, failures: b.failures, openedAt: b.opened_at })),
  };
}
