// Order email reconciliation: turns per-email facts into normalized orders.
// Pure and deterministic: the same set of facts, in any order and with any
// repetition, yields identical output. Nothing here implies arrival or
// ownership; facts that cannot be reconciled go to `issues`, never guessed.

import type {
  NormalizedOrder, NormalizedOrderLine, OrderEmailFact, OrderEmailLineFact, ReconcileIssue, ReconcileResult,
} from "./order-types.ts";
import {
  lineKeyFor, normalizeLine, normalizeMerchantKey, normalizeOrderNumber, orderDedupeKey, softLineKeyFor, toMinor,
} from "./order-types.ts";

export * from "./order-types.ts";
export * from "./investigation.ts";

interface Prepared {
  fact: OrderEmailFact;
  merchantKey: string;
  orderNumber: string;
  orderId: string;
  occurredAt: string;
  dedupeKey: string;
  /** Normalized original order number for a remake that names a different order. */
  original: string;
}

const softKeyOfExisting = (line: NormalizedOrderLine): string =>
  softLineKeyFor({ productName: line.productName, fitOptions: line.fitOptions, ...(line.size ? { size: line.size } : {}) });

/**
 * Finds the existing line an emailed line refers to: exact line key, or, only
 * when the emailed line quotes no product code, the UNIQUE existing line with
 * the same name + size + fit options. Name alone never matches.
 */
function resolveLine(lines: NormalizedOrderLine[], raw: OrderEmailLineFact): NormalizedOrderLine | null {
  const key = lineKeyFor(raw);
  const exact = lines.find((l) => l.lineKey === key);
  if (exact) return exact;
  if (raw.productCode?.trim()) return null;
  const soft = softLineKeyFor(raw);
  const candidates = lines.filter((l) => softKeyOfExisting(l) === soft);
  return candidates.length === 1 ? (candidates[0] ?? null) : null;
}

const pushUnique = (list: string[], value: string): void => {
  if (!list.includes(value)) list.push(value);
};
const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

export function reconcileOrderFacts(facts: OrderEmailFact[]): ReconcileResult {
  const issues: ReconcileIssue[] = [];
  const issue = (messageId: string, reason: string): void => {
    if (!issues.some((i) => i.messageId === messageId && i.reason === reason)) issues.push({ messageId, reason });
  };
  const prepared: Prepared[] = [];
  const seen = new Set<string>();
  for (const fact of facts) {
    const messageId = fact.messageId ?? "";
    const merchantKey = normalizeMerchantKey(fact.merchant ?? "");
    const orderNumber = normalizeOrderNumber(fact.orderNumber);
    const sentMs = Date.parse(fact.sentAt ?? "");
    if (!messageId) { issue("", `${fact.kind} fact has no message id; not reconciled`); continue; }
    if (!merchantKey) { issue(messageId, "missing merchant; not reconciled"); continue; }
    if (!orderNumber) { issue(messageId, "missing order number; not reconciled"); continue; }
    if (Number.isNaN(sentMs)) { issue(messageId, "unreadable sent time; not reconciled"); continue; }
    const dedupeKey = orderDedupeKey(merchantKey, orderNumber, fact.kind, messageId);
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    const originalRaw = fact.kind === "remake" ? normalizeOrderNumber(fact.originalOrderNumber) : "";
    prepared.push({
      fact, merchantKey, orderNumber, orderId: `${merchantKey}:${orderNumber}`,
      occurredAt: new Date(sentMs).toISOString(), dedupeKey,
      original: originalRaw !== orderNumber ? originalRaw : "",
    });
  }
  prepared.sort((a, b) => cmp(a.occurredAt, b.occurredAt) || cmp(a.dedupeKey, b.dedupeKey));

  const orders = new Map<string, NormalizedOrder>();
  const remakeSource = new Map<string, string>();
  const creates = (p: Prepared): boolean =>
    p.fact.kind === "confirmation" || p.fact.kind === "dispatch" || (p.fact.kind === "remake" && p.original !== "");

  // Phase 1: emails that establish an order (confirmation, dispatch, remake of another order).
  for (const p of prepared.filter(creates)) {
    const { fact } = p;
    let order = orders.get(p.orderId);
    if (!order) {
      order = {
        merchant: fact.merchant.trim(), merchantKey: p.merchantKey, orderNumber: p.orderNumber, orderedOn: null,
        currency: null, totalMinor: null, lines: [], events: [], replaces: null, sourceRefs: [],
      };
      orders.set(p.orderId, order);
    }
    pushUnique(order.sourceRefs, fact.messageId);
    const factCurrency = fact.currency?.trim().toUpperCase() || null;
    const total = toMinor(fact.total);
    if (fact.total !== undefined && total === null) issue(fact.messageId, `unreadable total "${fact.total}"; left unset`);
    if (fact.kind === "confirmation") {
      order.orderedOn ??= p.occurredAt.slice(0, 10);
      order.totalMinor ??= total;
    }
    if (fact.kind === "remake" && !order.replaces) {
      order.replaces = { merchantKey: p.merchantKey, orderNumber: p.original };
      remakeSource.set(p.orderId, fact.messageId);
    }
    const lineKeys: string[] = [];
    const addedHere = new Set<string>();
    for (const raw of fact.lines ?? []) {
      const incoming = normalizeLine(raw, factCurrency);
      if (raw.price !== undefined && incoming.priceMinor === null) issue(fact.messageId, `unreadable price "${raw.price}" for ${incoming.productName}; left unset`);
      const existing = resolveLine(order.lines, raw);
      if (!existing) {
        order.lines.push(incoming);
        addedHere.add(incoming.lineKey);
        pushUnique(lineKeys, incoming.lineKey);
        continue;
      }
      // The same line listed twice in one email adds quantity; a repeated email never does.
      if (addedHere.has(existing.lineKey)) existing.quantity += incoming.quantity;
      existing.colour ??= incoming.colour;
      existing.priceMinor ??= incoming.priceMinor;
      existing.currency ??= incoming.currency;
      if (incoming.arrivalEstimate && (fact.kind === "dispatch" || !existing.arrivalEstimate)) existing.arrivalEstimate = incoming.arrivalEstimate;
      pushUnique(lineKeys, existing.lineKey);
    }
    order.currency ??= factCurrency ?? order.lines.find((l) => l.currency)?.currency ?? null;
    order.events.push({ kind: fact.kind, dedupeKey: p.dedupeKey, occurredAt: p.occurredAt, sourceRef: fact.messageId, lineKeys, amountMinor: total });
  }

  // Phase 2: emails about an existing order. No lines named means the whole order (empty lineKeys).
  for (const p of prepared.filter((x) => !creates(x))) {
    const { fact } = p;
    const order = orders.get(p.orderId);
    if (!order) {
      issue(fact.messageId, `${fact.kind} for unknown order ${p.orderNumber} (${fact.merchant.trim()}); not applied`);
      continue;
    }
    const lineKeys: string[] = [];
    const unmatched: string[] = [];
    for (const raw of fact.lines ?? []) {
      const existing = resolveLine(order.lines, raw);
      if (existing) pushUnique(lineKeys, existing.lineKey);
      else unmatched.push(raw.productName.trim());
    }
    if (unmatched.length > 0) {
      issue(fact.messageId, `${fact.kind} names a line not on order ${p.orderNumber}: ${unmatched.join("; ")}; not applied`);
      continue;
    }
    let amountMinor: number | null = null;
    if (fact.kind === "refund") {
      amountMinor = toMinor(fact.refundAmount);
      if (fact.refundAmount !== undefined && amountMinor === null) issue(fact.messageId, `unreadable refund amount "${fact.refundAmount}"; left unset`);
    }
    pushUnique(order.sourceRefs, fact.messageId);
    order.events.push({ kind: fact.kind, dedupeKey: p.dedupeKey, occurredAt: p.occurredAt, sourceRef: fact.messageId, lineKeys, amountMinor });
  }

  // Phase 3: link remake lines to the original's lines instead of doubling them.
  for (const [orderId, order] of orders) {
    if (!order.replaces) continue;
    const original = orders.get(`${order.replaces.merchantKey}:${order.replaces.orderNumber}`);
    if (!original) {
      issue(remakeSource.get(orderId) ?? "", `original order ${order.replaces.orderNumber} not found; remake line links not established`);
      continue;
    }
    for (const line of order.lines) {
      const exact = original.lines.find((l) => l.lineKey === line.lineKey);
      const soft = original.lines.filter((l) => (!l.productCode || !line.productCode) && softKeyOfExisting(l) === softKeyOfExisting(line));
      // A remake usually changes size or options, so fall back to the unique line with the same product code.
      const byCode = line.productCode ? original.lines.filter((l) => l.productCode?.toUpperCase() === line.productCode?.toUpperCase()) : [];
      const match = exact ?? (soft.length === 1 ? soft[0] : undefined) ?? (byCode.length === 1 ? byCode[0] : undefined);
      line.replacesLineKey = match?.lineKey ?? null;
    }
  }

  const result = [...orders.values()].sort((a, b) => cmp(a.merchantKey, b.merchantKey) || cmp(a.orderNumber, b.orderNumber));
  for (const order of result) {
    order.sourceRefs.sort(cmp);
    order.events.sort((a, b) => cmp(a.occurredAt, b.occurredAt) || cmp(a.dedupeKey, b.dedupeKey));
  }
  issues.sort((a, b) => cmp(a.messageId, b.messageId) || cmp(a.reason, b.reason));
  return { orders: result, issues };
}
