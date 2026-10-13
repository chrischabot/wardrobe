import { beforeAll, describe, expect, it } from "vitest";
import { all, first, isCommandError } from "@garderobe/domain";
import { refundShares, caseNeedsNoReminders, classifyChange, describeChange, expectedVersionsFor, getOrder, indirectReach } from "../src/index.ts";
import { createWorld, setNow, type World } from "./helpers.ts";

/** The signed-in owner in the app: these tests exercise the purchase and return handlers' own guards. */
const TAP = { actor: "owner" as const, channel: "ios" as const, authorization: "owner_tap" as const };

async function rejects(p: Promise<unknown>, code: string): Promise<void> {
  try {
    await p;
  } catch (e) {
    expect(isCommandError(e), String(e)).toBe(true);
    expect((e as { code: string }).code).toBe(code);
    return;
  }
  throw new Error(`expected a ${code} rejection`);
}

const orderVersion = async (w: World, orderId: string) => (await first<{ version: number }>(w.h.db, "SELECT version FROM orders WHERE user_id = ? AND order_id = ?", w.owner.userId, orderId))!.version;
const lineRow = async (w: World, orderId: string, lineKey: string) =>
  (await first<{ line_id: string; state: string; garment_id: string | null; arrival_estimate: string | null; refunded_minor: number }>(w.h.db, "SELECT line_id, state, garment_id, arrival_estimate, refunded_minor FROM order_lines WHERE user_id = ? AND order_id = ? AND line_key = ?", w.owner.userId, orderId, lineKey))!;

describe("purchase and return guards found in review (real D1, the owner's real imported wardrobe; synthetic SYNTH orders)", () => {
  let w: World;
  beforeAll(async () => {
    w = await createWorld();
    setNow(w, "2026-09-15T08:00:00Z");
  });

  it("splits a refund in minor units without losing the remainder", () => {
    expect(refundShares(10001, 2)).toEqual([5001, 5000]);
    expect(refundShares(10, 3)).toEqual([4, 3, 3]);
    expect(refundShares(10, 3).reduce((a, b) => a + b, 0)).toBe(10);
    expect(refundShares(5, 0)).toEqual([]);
  });

  it("a whole-order refund keeps every minor unit across the lines", async () => {
    const o = await w.owner.exec("purchase.import_order", { merchant: "SYNTH Shop", merchantKey: "synth-refund", orderNumber: "SR-1", currency: "GBP", lines: [{ lineKey: "a", productName: "SYNTH A", priceMinor: 20000 }, { lineKey: "b", productName: "SYNTH B", priceMinor: 20000 }] }, TAP);
    const orderId = String(o.result["orderId"]);
    await w.owner.exec("purchase.record_event", { orderId, event: { kind: "refund", dedupeKey: "sr-1", occurredAt: "2026-09-14T09:00:00Z", sourceRef: "synthetic:refund", lineKeys: [], amountMinor: 10001 } }, TAP);
    const rows = await all<{ refunded_minor: number }>(w.h.db, "SELECT refunded_minor FROM order_lines WHERE user_id = ? AND order_id = ?", w.owner.userId, orderId);
    expect(rows.reduce((s, r) => s + r.refunded_minor, 0)).toBe(10001);
  });

  it("a re-import that only fills in a missing detail is recorded, not reported as a no-op and discarded", async () => {
    const base = { merchant: "SYNTH Shop", merchantKey: "synth-enrich", orderNumber: "SE-1", currency: "GBP", lines: [{ lineKey: "a", productName: "SYNTH shirt" }] };
    const o = await w.owner.exec("purchase.import_order", base, TAP);
    const orderId = String(o.result["orderId"]);
    const v = await orderVersion(w, orderId);
    const enriched = await w.owner.exec("purchase.import_order", { ...base, lines: [{ lineKey: "a", productName: "SYNTH shirt", arrivalEstimate: "2026-09-20" }] }, TAP);
    expect(enriched.outcome).toBe("merged");
    expect(enriched.summary).toContain("gained missing details");
    expect((await lineRow(w, orderId, "a")).arrival_estimate).toBe("2026-09-20");
    expect(await orderVersion(w, orderId)).toBe(v + 1);
    // The same facts again change nothing.
    expect((await w.owner.exec("purchase.import_order", { ...base, lines: [{ lineKey: "a", productName: "SYNTH shirt", arrivalEstimate: "2026-09-20" }] }, TAP)).outcome).toBe("noop");
  });

  it("a line logged earlier without its incoming record gets the record asked for later, once", async () => {
    const base = { merchant: "SYNTH Shop", merchantKey: "synth-incoming", orderNumber: "SI-1", currency: "GBP", lines: [{ lineKey: "a", productName: "SYNTH knit" }] };
    const o = await w.owner.exec("purchase.import_order", base, TAP);
    const orderId = String(o.result["orderId"]);
    expect((await lineRow(w, orderId, "a")).garment_id).toBeNull();
    const incoming = [{ lineKey: "a", category: "knitwear", roles: ["top"], careChannel: "handwash" as const }];
    const later = await w.owner.exec("purchase.import_order", { ...base, incoming }, TAP);
    expect(later.outcome).toBe("merged");
    const records = later.result["incomingRecords"] as { lineId: string; garmentId: string }[];
    expect(records).toHaveLength(1);
    expect((await lineRow(w, orderId, "a")).garment_id).toBe(records[0]!.garmentId);
    const g = await first<{ acquisition: string }>(w.h.db, "SELECT acquisition FROM garments WHERE user_id = ? AND garment_id = ?", w.owner.userId, records[0]!.garmentId);
    expect(g!.acquisition).toBe("incoming");
    // Asking again never makes a second record for the same line.
    const again = await w.owner.exec("purchase.import_order", { ...base, incoming }, TAP);
    expect(again.outcome).toBe("noop");
  });

  it("refuses two remake lines replacing the same original line, and a remake bumps the original order's version", async () => {
    const orig = await w.owner.exec("purchase.import_order", { merchant: "SYNTH Shop", merchantKey: "synth-remake", orderNumber: "SM-1", lines: [{ lineKey: "a", productName: "SYNTH trousers" }] }, TAP);
    const origId = String(orig.result["orderId"]);
    const replaces = { merchantKey: "synth-remake", orderNumber: "SM-1" };
    await rejects(
      w.owner.exec("purchase.import_order", { merchant: "SYNTH Shop", merchantKey: "synth-remake", orderNumber: "SM-1-R", replaces, lines: [{ lineKey: "r1", productName: "SYNTH trousers", replacesLineKey: "a" }, { lineKey: "r2", productName: "SYNTH trousers", replacesLineKey: "a" }] }, TAP),
      "invalid_command",
    );
    const before = await orderVersion(w, origId);
    const remake = await w.owner.exec("purchase.import_order", { merchant: "SYNTH Shop", merchantKey: "synth-remake", orderNumber: "SM-1-R", replaces, lines: [{ lineKey: "r1", productName: "SYNTH trousers", replacesLineKey: "a" }] }, TAP);
    expect(remake.outcome).toBe("committed");
    expect(await orderVersion(w, origId)).toBe(before + 1);
    expect((await lineRow(w, origId, "a")).state).toBe("exchanged");
    // A second replacement order for the same, already exchanged line is refused: the purchase was remade once.
    const garmentsBefore = (await all(w.h.db, "SELECT garment_id FROM garments WHERE user_id = ?", w.owner.userId)).length;
    await rejects(
      w.owner.exec("purchase.import_order", { merchant: "SYNTH Shop", merchantKey: "synth-remake", orderNumber: "SM-1-R2", replaces, lines: [{ lineKey: "r1", productName: "SYNTH trousers", replacesLineKey: "a" }], incoming: [{ lineKey: "r1", category: "knitwear", roles: ["top"], careChannel: "handwash" as const }] }, TAP),
      "precondition_failed",
    );
    expect((await all(w.h.db, "SELECT garment_id FROM garments WHERE user_id = ?", w.owner.userId)).length).toBe(garmentsBefore);
  });

  it("an event that names a line twice gives that line one refund share and lists it once", async () => {
    const o = await w.owner.exec("purchase.import_order", { merchant: "SYNTH Shop", merchantKey: "synth-dupkey", orderNumber: "SD-1", currency: "GBP", lines: [{ lineKey: "a", productName: "SYNTH scarf", priceMinor: 1000 }, { lineKey: "b", productName: "SYNTH gloves", priceMinor: 1000 }] }, TAP);
    const orderId = String(o.result["orderId"]);
    await w.owner.exec("purchase.record_event", { orderId, event: { kind: "refund", dedupeKey: "sd-1", occurredAt: "2026-09-14T09:00:00Z", sourceRef: "synthetic:refund", lineKeys: ["a", "a"], amountMinor: 500 } }, TAP);
    expect((await lineRow(w, orderId, "a")).refunded_minor).toBe(500);
    expect((await lineRow(w, orderId, "b")).refunded_minor).toBe(0);
    const ev = await first<{ line_ids_json: string }>(w.h.db, "SELECT line_ids_json FROM order_events WHERE user_id = ? AND order_id = ? AND dedupe_key = 'sd-1'", w.owner.userId, orderId);
    expect(JSON.parse(ev!.line_ids_json)).toHaveLength(1);
  });

  it("a price supplied by a re-import is the price a later refund in the same import is measured against", async () => {
    const base = { merchant: "SYNTH Shop", merchantKey: "synth-lateprice", orderNumber: "SL-1", currency: "GBP", lines: [{ lineKey: "a", productName: "SYNTH jacket" }] };
    const o = await w.owner.exec("purchase.import_order", base, TAP);
    const orderId = String(o.result["orderId"]);
    const stateBefore = (await lineRow(w, orderId, "a")).state;
    await w.owner.exec("purchase.import_order", { ...base, lines: [{ lineKey: "a", productName: "SYNTH jacket", priceMinor: 10000 }], events: [{ kind: "refund", dedupeKey: "sl-1", occurredAt: "2026-09-14T09:00:00Z", sourceRef: "synthetic:refund", lineKeys: ["a"], amountMinor: 4000 }] }, TAP);
    const line = await lineRow(w, orderId, "a");
    expect(line.refunded_minor).toBe(4000);
    // A partial refund of a now-priced line keeps its state; it is not marked refunded.
    expect(line.state).toBe(stateBefore);
  });

  it("an arrival cannot be recorded on a cancelled or refunded line", async () => {
    const o = await w.owner.exec("purchase.import_order", { merchant: "SYNTH Shop", merchantKey: "synth-cancel", orderNumber: "SC-1", lines: [{ lineKey: "a", productName: "SYNTH coat", priceMinor: 1000 }, { lineKey: "b", productName: "SYNTH hat", priceMinor: 1000 }] }, TAP);
    const orderId = String(o.result["orderId"]);
    await w.owner.exec("purchase.record_event", { orderId, event: { kind: "cancellation", dedupeKey: "sc-c", occurredAt: "2026-09-14T09:00:00Z", sourceRef: "synthetic:c", lineKeys: ["a"] } }, TAP);
    await w.owner.exec("purchase.record_event", { orderId, event: { kind: "refund", dedupeKey: "sc-r", occurredAt: "2026-09-14T09:00:00Z", sourceRef: "synthetic:r", lineKeys: ["b"], amountMinor: 1000 } }, TAP);
    const a = await lineRow(w, orderId, "a");
    const b = await lineRow(w, orderId, "b");
    expect([a.state, b.state]).toEqual(["cancelled", "refunded"]);
    await rejects(w.owner.exec("purchase.mark_delivered", { orderId, lineId: a.line_id, deliveredOn: "2026-09-15" }, TAP), "conflict");
    await rejects(w.owner.exec("purchase.mark_delivered", { orderId, lineId: b.line_id, deliveredOn: "2026-09-15" }, TAP), "conflict");
  });

  it("undoing a recorded delivery is refused once the order changed since; undone straight away it restores the line", async () => {
    const o = await w.owner.exec("purchase.import_order", { merchant: "SYNTH Shop", merchantKey: "synth-deliver", orderNumber: "SD-1", lines: [{ lineKey: "a", productName: "SYNTH scarf" }, { lineKey: "b", productName: "SYNTH gloves" }] }, TAP);
    const orderId = String(o.result["orderId"]);
    const a = await lineRow(w, orderId, "a");
    const marked = await w.owner.exec("purchase.mark_delivered", { orderId, lineId: a.line_id, deliveredOn: "2026-09-15" }, TAP);
    await w.owner.exec("purchase.record_event", { orderId, event: { kind: "dispatch", dedupeKey: "sd-d", occurredAt: "2026-09-15T09:00:00Z", sourceRef: "synthetic:d", lineKeys: ["b"] } }, TAP);
    await rejects(w.owner.exec("command.undo", { commandId: marked.commandId }, TAP), "not_undoable");
    expect((await lineRow(w, orderId, "a")).state).toBe("delivered");

    const b = await lineRow(w, orderId, "b");
    const markedB = await w.owner.exec("purchase.mark_delivered", { orderId, lineId: b.line_id, deliveredOn: "2026-09-15" }, TAP);
    await w.owner.exec("command.undo", { commandId: markedB.commandId }, TAP);
    expect((await lineRow(w, orderId, "b")).state).toBe("dispatched");
  });

  it("an arrival report for a garment already received still records the waiting order line", async () => {
    const o = await w.owner.exec("purchase.import_order", { merchant: "SYNTH Shop", merchantKey: "synth-arrival", orderNumber: "SA-1", lines: [{ lineKey: "a", productName: "SYNTH cardigan" }], incoming: [{ lineKey: "a", category: "knitwear", roles: ["top"], careChannel: "handwash" }] }, TAP);
    const orderId = String(o.result["orderId"]);
    const garmentId = (o.result["incomingRecords"] as { garmentId: string }[])[0]!.garmentId;
    // The piece was received on its own, without the order line.
    await w.owner.exec("garment.receive", { garmentId }, TAP);
    expect((await lineRow(w, orderId, "a")).state).toBe("ordered");
    const report = await w.owner.exec("assistant.report_arrival", { garmentId, deliveredOn: "2026-09-15" }, TAP);
    expect(report.outcome).not.toBe("noop");
    expect(report.summary).toContain("already recorded as arrived");
    expect((await lineRow(w, orderId, "a")).state).toBe("delivered");
    // Its undo takes back only the order line; the earlier receipt of the piece stands.
    await w.owner.exec("command.undo", { commandId: report.commandId }, TAP);
    expect((await lineRow(w, orderId, "a")).state).toBe("ordered");
    const g = await first<{ acquisition: string }>(w.h.db, "SELECT acquisition FROM garments WHERE user_id = ? AND garment_id = ?", w.owner.userId, garmentId);
    expect(g!.acquisition).toBe("owned");
    // With nothing left waiting, a repeat report changes nothing.
    await w.owner.exec("purchase.mark_delivered", { orderId, lineId: (await lineRow(w, orderId, "a")).line_id, deliveredOn: "2026-09-15" }, TAP);
    expect((await w.owner.exec("assistant.report_arrival", { garmentId, deliveredOn: "2026-09-15" }, TAP)).outcome).toBe("noop");
  });

  it("undoing the opening of a return is refused once the return was updated, and works straight after opening", async () => {
    const g = await w.garment("California plaid");
    const opened = await w.owner.exec("return.open_case", { kind: "return", garmentId: g.garmentId }, TAP);
    await w.owner.exec("return.update_case", { caseId: opened.result["caseId"], state: "requested" }, TAP);
    await rejects(w.owner.exec("command.undo", { commandId: opened.commandId }, TAP), "not_undoable");
    const state = await first<{ state: string }>(w.h.db, "SELECT state FROM return_cases WHERE user_id = ? AND case_id = ?", w.owner.userId, opened.result["caseId"]);
    expect(state!.state).toBe("requested");

    const second = await w.owner.exec("return.open_case", { kind: "return", garmentId: g.garmentId }, TAP);
    await w.owner.exec("command.undo", { commandId: second.commandId }, TAP);
    const cancelled = await first<{ state: string }>(w.h.db, "SELECT state FROM return_cases WHERE user_id = ? AND case_id = ?", w.owner.userId, second.result["caseId"]);
    expect(cancelled!.state).toBe("cancelled");
    await rejects(w.owner.exec("command.undo", { commandId: second.commandId }, TAP), "not_undoable");
  });

  it("one finished-state rule: undo back to a finished case leaves no reminder pending", async () => {
    expect(caseNeedsNoReminders("posted", "post")).toBe(true);
    expect(caseNeedsNoReminders("posted", "retailer_receipt")).toBe(false);
    expect(caseNeedsNoReminders("refunded", null)).toBe(true);
    expect(caseNeedsNoReminders("requested", "post")).toBe(false);

    const g = await w.garment("Clark oxford — beige");
    const terms = { windowDays: 30, concerns: "post", triggerEvent: "delivery", sourceRef: "https://shop.example/returns#synthetic", checkedOn: "2026-09-15" };
    const opened = await w.owner.exec("return.open_case", { kind: "return", garmentId: g.garmentId, terms, triggerDate: "2026-09-14" }, TAP);
    const caseId = String(opened.result["caseId"]);
    await w.owner.exec("return.update_case", { caseId, state: "closed" }, TAP);
    // Reopening with a later delivery date queues reminders for the new deadline...
    const reopened = await w.owner.exec("return.update_case", { caseId, state: "requested", triggerDate: "2026-09-15" }, TAP);
    const pending = () => all(w.h.db, "SELECT 1 FROM effects WHERE user_id = ? AND kind = 'notification.return_reminder' AND target_key = ? AND state = 'pending'", w.owner.userId, `return:${caseId}`);
    expect((await pending()).length).toBeGreaterThan(0);
    // ...and taking that back to the closed case withdraws every one of them.
    await w.owner.exec("command.undo", { commandId: reopened.commandId }, TAP);
    expect(await pending()).toHaveLength(0);
  });

  it("linking an exchange bumps the incoming order's version", async () => {
    const outgoing = await w.owner.exec("purchase.import_order", { merchant: "SYNTH Shop", merchantKey: "synth-exchange", orderNumber: "SX-1", lines: [{ lineKey: "a", productName: "SYNTH shirt 15.5" }], incoming: [{ lineKey: "a", category: "shirt", roles: ["top"], careChannel: "service" }] }, TAP);
    const outId = String(outgoing.result["orderId"]);
    const outLine = await lineRow(w, outId, "a");
    const incoming = await w.owner.exec("purchase.import_order", { merchant: "SYNTH Shop", merchantKey: "synth-exchange", orderNumber: "SX-2", lines: [{ lineKey: "a", productName: "SYNTH shirt 16" }] }, TAP);
    const inId = String(incoming.result["orderId"]);
    const c = await w.owner.exec("return.open_case", { kind: "exchange", orderId: outId, lineId: outLine.line_id }, TAP);
    const before = await orderVersion(w, inId);
    await w.owner.exec("return.link_exchange", { caseId: c.result["caseId"], incomingOrderId: inId, incomingLineId: (incoming.result["lineIds"] as string[])[0] }, TAP);
    expect(await orderVersion(w, inId)).toBe(before + 1);
    await rejects(w.owner.exec("command.undo", { commandId: incoming.commandId }, TAP), "not_undoable");

    // Garment-only exchange linked to an incoming order also bumps its version and blocks order undo.
    const g = await w.garment("California plaid");
    const garmentOnly = await w.owner.exec("return.open_case", { kind: "exchange", garmentId: g.garmentId }, TAP);
    const incoming2 = await w.owner.exec("purchase.import_order", { merchant: "SYNTH Shop", merchantKey: "synth-exchange", orderNumber: "SX-3", lines: [{ lineKey: "a", productName: "SYNTH plaid M" }] }, TAP);
    const inId2 = String(incoming2.result["orderId"]);
    const before2 = await orderVersion(w, inId2);
    await w.owner.exec("return.link_exchange", { caseId: garmentOnly.result["caseId"], incomingOrderId: inId2, incomingLineId: (incoming2.result["lineIds"] as string[])[0] }, TAP);
    expect(await orderVersion(w, inId2)).toBe(before2 + 1);
    await rejects(w.owner.exec("command.undo", { commandId: incoming2.commandId }, TAP), "not_undoable");
  });

  it("a project event that moves stock without naming pieces counts every piece of the project towards the cap", async () => {
    const ids = (await all<{ garment_id: string }>(w.h.db, "SELECT garment_id FROM garments WHERE user_id = ? AND acquisition = 'owned' ORDER BY garment_id LIMIT 23", w.owner.userId)).map((r) => r.garment_id);
    expect(ids).toHaveLength(23);
    const big = await w.owner.exec("lifecycle.open_project", { kind: "seasonal_storage", title: "SYNTH big storage", items: ids.slice(0, 21).map((garmentId) => ({ garmentId })) }, TAP);
    const small = await w.owner.exec("lifecycle.open_project", { kind: "seasonal_storage", title: "SYNTH small storage", items: ids.slice(21, 23).map((garmentId) => ({ garmentId })) }, TAP);
    const event = (projectId: unknown) => ({ projectId, kind: "discarded", moveStock: true, garmentIds: [] as string[] });
    const bigReach = await indirectReach(w.h.db, w.owner.userId, "lifecycle.record_event", event(big.result["projectId"]));
    expect(bigReach).toBe(21);
    expect(classifyChange("lifecycle.record_event", event(big.result["projectId"]), "ios", bigReach)).toBe("confirm");
    const smallReach = await indirectReach(w.h.db, w.owner.userId, "lifecycle.record_event", event(small.result["projectId"]));
    expect(smallReach).toBe(2);
    expect(classifyChange("lifecycle.record_event", event(small.result["projectId"]), "ios", smallReach)).toBe("direction");
    // Naming the pieces bounds the reach by the list itself.
    expect(await indirectReach(w.h.db, w.owner.userId, "lifecycle.record_event", { ...event(big.result["projectId"]), garmentIds: [ids[0]!] })).toBe(0);
  });

  it("a waiting return update names the case it changes and says what it clears", async () => {
    const g = await w.garment("Clark oxford — evergreen");
    const opened = await w.owner.exec("return.open_case", { kind: "return", garmentId: g.garmentId, nextAction: "Print the label" }, TAP);
    const summary = await describeChange(w.h.db, w.owner.userId, "return.update_case", { caseId: opened.result["caseId"], nextAction: "" });
    expect(summary).toContain(g.name);
    expect(summary).toContain("clear the next step");
    expect(summary).not.toContain("no change");
  });

  it("a waiting delivery is held to the order and to the record of the piece its line names", async () => {
    const o = await w.owner.exec("purchase.import_order", { merchant: "SYNTH Shop", merchantKey: "synth-versions", orderNumber: "SV-1", lines: [{ lineKey: "a", productName: "SYNTH belt" }], incoming: [{ lineKey: "a", category: "shirt", roles: ["top"], careChannel: "service" }] }, TAP);
    const orderId = String(o.result["orderId"]);
    const garmentId = (o.result["incomingRecords"] as { garmentId: string }[])[0]!.garmentId;
    const line = await lineRow(w, orderId, "a");
    const versions = await expectedVersionsFor(w.h.db, w.owner.userId, "purchase.mark_delivered", { orderId, lineId: line.line_id, deliveredOn: "2026-09-15" });
    expect(Object.keys(versions).sort()).toEqual([`garment_record:${garmentId}`, `order:${orderId}`].sort());
    // Confirmed after the order changed, it is refused rather than applied to an order the owner was not shown.
    await w.owner.exec("purchase.record_event", { orderId, event: { kind: "dispatch", dedupeKey: "sv-d", occurredAt: "2026-09-15T09:00:00Z", sourceRef: "synthetic:d", lineKeys: ["a"] } }, TAP);
    await rejects(w.owner.exec("purchase.mark_delivered", { orderId, lineId: line.line_id, deliveredOn: "2026-09-15" }, { ...TAP, expectedVersions: versions }), "conflict");
  });

  it("an order cannot name itself as the order it replaces (its version would advance twice); nothing is written", async () => {
    const base = { merchant: "SYNTH Shop", merchantKey: "synth-self", orderNumber: "SS-1", currency: "GBP", lines: [{ lineKey: "a", productName: "SYNTH self A", priceMinor: 1000 }] };
    const o = await w.owner.exec("purchase.import_order", base, TAP);
    const orderId = String((o.result as { orderId: string }).orderId);
    const before = await orderVersion(w, orderId);
    await rejects(w.owner.exec("purchase.import_order", { ...base, lines: [{ lineKey: "b", productName: "SYNTH self B", priceMinor: 1000, replacesLineKey: "a" }], replaces: { merchantKey: "synth-self", orderNumber: "SS-1" } }, TAP), "invalid_command");
    expect(await orderVersion(w, orderId)).toBe(before);
  });

  it("shows a return case's recorded refund on the order line it refunds and never drops the total when a partial order notice arrives afterwards (journey D08-1)", async () => {
    const o = await w.owner.exec("purchase.import_order", { merchant: "SYNTH Shop", merchantKey: "synth-d08-1", orderNumber: "D08-1", currency: "GBP", lines: [{ lineKey: "shirt-L", productName: "SYNTH shirt", priceMinor: 12_000, currency: "GBP" }] }, TAP);
    const orderId = String((o.result as { orderId: string }).orderId);
    const lineId = (await lineRow(w, orderId, "shirt-L")).line_id;
    const opened = await w.owner.exec("return.open_case", { kind: "return", orderId, lineId, refundExpectedMinor: 12_000, currency: "GBP" }, TAP);
    const caseId = String(opened.result["caseId"]);
    await w.owner.exec("return.update_case", { caseId, refundReceivedMinor: 5_000 }, TAP);
    expect((await getOrder(w.h.db, w.owner.principal(), orderId))!.lines[0]!.refundedMinor).toBe(5_000);
    await w.owner.exec("return.update_case", { caseId, refundReceivedMinor: 7_000 }, TAP);
    expect((await getOrder(w.h.db, w.owner.principal(), orderId))!.lines[0]!.refundedMinor).toBe(12_000);
    // A subsequent partial order-level refund notice for the first 5,000 does not drop the displayed refund from 12,000 to 5,000.
    await w.owner.exec("purchase.record_event", { orderId, event: { kind: "refund", dedupeKey: "d08-1-ref-1", occurredAt: "2026-09-15T10:00:00Z", sourceRef: "synthetic:ref1", lineKeys: ["shirt-L"], amountMinor: 5_000 } }, TAP);
    expect((await getOrder(w.h.db, w.owner.principal(), orderId))!.lines[0]!.refundedMinor).toBe(12_000);
  });
});
