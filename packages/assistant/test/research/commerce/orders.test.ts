import { describe, it, expect } from "vitest";
import { lineKeyFor, normalizeMerchantKey, normalizeOrderNumber, reconcileOrderFacts, toMinor } from "../../../src/research/commerce/index.ts";
import type { OrderEmailFact } from "../../../src/research/commerce/index.ts";

const shirt = { productName: "Oxford Shirt", productCode: "SH-100", fabricCode: "OX-BLU", size: "16", colour: "Blue", price: "195.00", currency: "GBP" };
const confirmation: OrderEmailFact = {
  kind: "confirmation", merchant: "Drake's", orderNumber: "#D1001", messageId: "m1", threadId: "t1",
  sentAt: "2025-03-01T10:00:00Z", lines: [shirt], total: "195.00", currency: "GBP",
};
const dispatch: OrderEmailFact = {
  kind: "dispatch", merchant: "DRAKES Ltd.", orderNumber: "D1001", messageId: "m3", sentAt: "2025-03-03T09:00:00Z",
  lines: [{ productName: "Oxford Shirt", size: "16", arrivalEstimate: "2025-03-06" }],
};

describe("normalization helpers", () => {
  it("normalizes merchant names to one key", () => {
    expect(normalizeMerchantKey("Drake's")).toBe("drakes");
    expect(normalizeMerchantKey("DRAKES Ltd.")).toBe("drakes");
    expect(normalizeOrderNumber(" #d 1001 ")).toBe("D1001");
  });

  it("converts decimal strings to minor units without float error", () => {
    expect(toMinor("195.00")).toBe(19500);
    expect(toMinor("19.99")).toBe(1999);
    expect(toMinor("1,295.5")).toBe(129550);
    expect(toMinor("0.07")).toBe(7);
    expect(toMinor("about 20")).toBeNull();
    expect(toMinor("1.999")).toBeNull();
  });

  it("builds line keys from codes, size and sorted fit options, not from the name", () => {
    const a = lineKeyFor({ productName: "Oxford Shirt", productCode: "sh-100", size: "16", fitOptions: { sleeve: "Long", collar: "Button" } });
    const b = lineKeyFor({ productName: "A different label", productCode: "SH-100", size: "16", fitOptions: { collar: "button", sleeve: "long" } });
    expect(a).toBe(b);
    expect(lineKeyFor({ productName: "Oxford Shirt", productCode: "SH-200", size: "16" })).not.toBe(lineKeyFor({ productName: "Oxford Shirt", productCode: "SH-100", size: "16" }));
    expect(lineKeyFor({ productName: "Oxford  shirt", size: "16" })).toBe(lineKeyFor({ productName: "oxford shirt", size: "16" }));
    expect(lineKeyFor({ productName: "Oxford Shirt", size: "16" })).not.toBe(lineKeyFor({ productName: "Oxford Shirt", size: "15.5" }));
  });
});

describe("reconcileOrderFacts", () => {
  it("merges a repeated confirmation without duplicating lines", () => {
    const repeat: OrderEmailFact = { ...confirmation, messageId: "m2", merchant: "Drakes", sentAt: "2025-03-01T10:05:00Z" };
    const { orders, issues } = reconcileOrderFacts([confirmation, repeat]);
    expect(issues).toEqual([]);
    expect(orders).toHaveLength(1);
    const order = orders[0];
    expect(order?.merchantKey).toBe("drakes");
    expect(order?.orderNumber).toBe("D1001");
    expect(order?.orderedOn).toBe("2025-03-01");
    expect(order?.totalMinor).toBe(19500);
    expect(order?.lines).toHaveLength(1);
    expect(order?.lines[0]?.quantity).toBe(1);
    expect(order?.lines[0]?.priceMinor).toBe(19500);
    expect(order?.sourceRefs).toEqual(["m1", "m2"]);
    expect(order?.events.map((e) => e.dedupeKey)).toEqual(["drakes:D1001:confirmation:m1", "drakes:D1001:confirmation:m2"]);
  });

  it("lets a dispatch enrich the existing order instead of adding a line", () => {
    const { orders } = reconcileOrderFacts([dispatch, confirmation]);
    const order = orders[0];
    expect(orders).toHaveLength(1);
    expect(order?.lines).toHaveLength(1);
    expect(order?.lines[0]?.arrivalEstimate).toBe("2025-03-06");
    expect(order?.lines[0]?.productCode).toBe("SH-100");
    expect(order?.events.map((e) => e.kind)).toEqual(["confirmation", "dispatch"]);
    expect(order?.events[1]?.lineKeys).toEqual([order?.lines[0]?.lineKey]);
  });

  it("creates the order from a dispatch that arrives before any confirmation", () => {
    const { orders, issues } = reconcileOrderFacts([dispatch]);
    expect(issues).toEqual([]);
    expect(orders[0]?.lines).toHaveLength(1);
    expect(orders[0]?.orderedOn).toBeNull();
    expect(orders[0]?.events.map((e) => e.kind)).toEqual(["dispatch"]);
  });

  it("keeps same-name lines with different codes or sizes separate", () => {
    const fact: OrderEmailFact = {
      ...confirmation,
      lines: [shirt, { ...shirt, productCode: "SH-200" }, { ...shirt, size: "15.5" }, shirt],
    };
    const { orders } = reconcileOrderFacts([fact]);
    expect(orders[0]?.lines).toHaveLength(3);
    expect(new Set(orders[0]?.lines.map((l) => l.lineKey)).size).toBe(3);
    // The identical line listed twice in one email is two units, not two lines.
    expect(orders[0]?.lines[0]?.quantity).toBe(2);
  });

  it("records refunds on the named line and whole-order events with empty lineKeys", () => {
    const refund: OrderEmailFact = {
      kind: "refund", merchant: "Drake's", orderNumber: "D1001", messageId: "m5", sentAt: "2025-03-10T12:00:00Z",
      refundAmount: "95.00", lines: [{ productName: "Oxford Shirt", productCode: "SH-100", fabricCode: "OX-BLU", size: "16" }],
    };
    const cancellation: OrderEmailFact = { kind: "cancellation", merchant: "Drake's", orderNumber: "D1001", messageId: "m6", sentAt: "2025-03-11T12:00:00Z" };
    const delivery: OrderEmailFact = { kind: "delivery", merchant: "Drake's", orderNumber: "D1001", messageId: "m4", sentAt: "2025-03-06T15:00:00Z" };
    const { orders, issues } = reconcileOrderFacts([confirmation, refund, cancellation, delivery]);
    expect(issues).toEqual([]);
    const order = orders[0];
    const refundEvent = order?.events.find((e) => e.kind === "refund");
    expect(refundEvent?.amountMinor).toBe(9500);
    expect(refundEvent?.lineKeys).toEqual([order?.lines[0]?.lineKey]);
    expect(order?.events.find((e) => e.kind === "cancellation")?.lineKeys).toEqual([]);
    // A carrier delivery email is only an event; the order and its lines carry no arrival or ownership state.
    expect(order?.events.map((e) => e.kind)).toEqual(["confirmation", "delivery", "refund", "cancellation"]);
    expect(Object.keys(order ?? {}).sort()).toEqual(["currency", "events", "lines", "merchant", "merchantKey", "orderNumber", "orderedOn", "replaces", "sourceRefs", "totalMinor"]);
  });

  it("links a remake to the original order and line instead of doubling it", () => {
    const remake: OrderEmailFact = {
      kind: "remake", merchant: "Drake's", orderNumber: "D1002", originalOrderNumber: "#D1001", messageId: "m7",
      sentAt: "2025-03-20T09:00:00Z", lines: [{ ...shirt, size: "16.5" }],
    };
    const { orders, issues } = reconcileOrderFacts([confirmation, remake]);
    expect(issues).toEqual([]);
    expect(orders.map((o) => o.orderNumber)).toEqual(["D1001", "D1002"]);
    expect(orders[0]?.lines).toHaveLength(1);
    expect(orders[1]?.replaces).toEqual({ merchantKey: "drakes", orderNumber: "D1001" });
    expect(orders[1]?.lines[0]?.replacesLineKey).toBe(orders[0]?.lines[0]?.lineKey);
    expect(orders[0]?.replaces).toBeNull();
  });

  it("is idempotent and independent of input order and repetition", () => {
    const facts = [confirmation, dispatch, { ...confirmation, messageId: "m2" }];
    const once = reconcileOrderFacts(facts);
    const again = reconcileOrderFacts([...facts].reverse().concat(facts));
    expect(again).toEqual(once);
    expect(JSON.stringify(reconcileOrderFacts(facts))).toBe(JSON.stringify(once));
  });

  it("reports facts it cannot reconcile as issues instead of guessing", () => {
    const orphanRefund: OrderEmailFact = { kind: "refund", merchant: "Drake's", orderNumber: "D9999", messageId: "m8", sentAt: "2025-03-10T12:00:00Z", refundAmount: "10.00" };
    const noNumber: OrderEmailFact = { ...confirmation, orderNumber: "  ", messageId: "m9" };
    const wrongLine: OrderEmailFact = {
      kind: "return", merchant: "Drake's", orderNumber: "D1001", messageId: "m10", sentAt: "2025-03-12T12:00:00Z",
      lines: [{ productName: "Oxford Shirt", productCode: "SH-999", size: "16" }],
    };
    const { orders, issues } = reconcileOrderFacts([confirmation, orphanRefund, noNumber, wrongLine]);
    expect(orders).toHaveLength(1);
    expect(orders[0]?.events.map((e) => e.kind)).toEqual(["confirmation"]);
    expect(issues.map((i) => i.messageId)).toEqual(["m10", "m8", "m9"]);
    expect(issues.find((i) => i.messageId === "m8")?.reason).toContain("unknown order D9999");
    expect(issues.find((i) => i.messageId === "m9")?.reason).toContain("missing order number");
    expect(issues.find((i) => i.messageId === "m10")?.reason).toContain("not on order");
  });
});
