/**
 * Journey 08: an overshirt goes back for a refund, and a knit is exchanged for the right size.
 *
 * Specification covered (requirements/garderobe-replacement-design.md):
 *  - section 10 "Return and exchange deadlines": sourced terms, their source and checked date, the
 *    triggering event, the deadline with its timezone and what it concerns (request, post, retailer
 *    receipt); the real delivery date; an unknown deadline is unresolved, never a guessed countdown;
 *    reminders initially seven and two days before an established deadline; next action, label,
 *    collection preference, shipment, retailer receipt, refund amount and refund state kept together;
 *    an exchange links outgoing and incoming variants without duplicate ownership; drafting or
 *    requesting a return does not remove stock, physical departure does.
 *  - section 10 "Purchases from email" / section 8: an order is not an arrival (arrival is an observed fact).
 *  - section 3 "Laundry, wear follow-through, and undo": receipts and undo.
 *  - section 17 acceptance row "Returns"; data-model row "Deadlines and feedback".
 *
 * Everything inside the Worker is real (HTTP API, MCP server, D1 ledger, the owner's real profile and
 * 127-garment inventory). The ordered items are NOT the owner's: they are three labelled SYNTHETIC
 * garments created through the ordinary commands (`isSynthetic: true`, names starting "SYNTHETIC"),
 * from a SYNTHETIC shop, because a return needs an item the owner would send back.
 * Test doubles relied on: the TEST DOUBLE weather behind `realOwnerAt` (not consulted by this journey),
 * test-signed sign-in, and the SDK MCP client over in-process fetch. No fake model, no calendar double.
 *
 * What the product exposes about reminders is the receipt of the command that queued them (their lead
 * times, due instants and the queued effects); delivery itself is outside this journey.
 *
 * No product defect was found by this file. (The wording of the owner's confirmation request for a
 * change a connected assistant sent is reported once, in journey 07.)
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { connectMcp, provisionOwner, toolResult, type McpConnection, type TestOwner } from "@garderobe/worker/testing";
import { addDays, exec, internalCodesIn, LONDON, mcpCommand, quantityIn, realOwnerAt, refused, type JourneyOwner } from "../src/world.ts";

const DAY_MS = 86_400_000;
const TERMS_URL = "https://synthetic-shop.example.test/returns (SYNTHETIC terms page)";

describe("Journey 08: an overshirt goes back, a knit is exchanged for the right size", () => {
  let j: JourneyOwner;
  let stranger: TestOwner;
  let mcp: McpConnection;
  let countsBefore: { owned: number; available: number; incoming: number; retired: number };

  let overshirt = "";
  let knitM = "";
  let knitL = "";
  let orderId = "";
  let overshirtLine = "";
  let knitMLine = "";
  let replacementOrderId = "";
  let knitLLine = "";
  let returnCase = "";
  let exchangeCase = "";
  let mistakenCase = "";
  let openReceipt: Awaited<ReturnType<typeof exec>>;

  const api = () => j.owner.api;
  const counts = async () => (await api().json("GET", "/v1/wardrobe")).counts;
  const item = (garmentId: string) => api().json("GET", `/v1/items/${garmentId}`);
  const cases = async (): Promise<any[]> => (await api().json("GET", "/v1/returns")).returns;
  const theCase = async (caseId: string) => (await cases()).find((c) => c.caseId === caseId);
  const orders = async (): Promise<any[]> => (await api().json("GET", "/v1/orders")).orders;
  const line = async (order: string, lineId: string) => (await orders()).find((o) => o.orderId === order).lines.find((l: any) => l.lineId === lineId);
  const update = (caseId: string, change: Record<string, unknown>) => exec(api(), "return.update_case", { caseId, ...change });
  const reminderEffects = (receipt: { effects: { kind: string; state: string }[] }) => receipt.effects.filter((e) => e.kind === "notification.return_reminder");

  /** A labelled SYNTHETIC garment on order (never the owner's real stock). */
  const syntheticIncoming = async (name: string, category: string) =>
    (await exec(api(), "garment.create", { name, category, roles: ["top"], careChannel: "service", acquisition: "incoming", quantity: 1, isSynthetic: true, source: { kind: "system", note: "synthetic ordered item for journey 08" } })).result.garmentId as string;

  beforeAll(async () => {
    j = await realOwnerAt("Returns journey home");
    stranger = await provisionOwner();
    countsBefore = await counts();
    mcp = await connectMcp(j.owner, { write: true, clientName: "Connected assistant (journey 08)" });
  });

  afterAll(async () => {
    await mcp?.close();
  });

  it("logging an order creates no owned stock: the two SYNTHETIC lines are on order, not in the wardrobe", async () => {
    overshirt = await syntheticIncoming("SYNTHETIC overshirt, size L (journey 08)", "shirt");
    knitM = await syntheticIncoming("SYNTHETIC knit, size M (journey 08)", "knitwear");
    const logged = await exec(api(), "purchase.import_order", {
      merchant: "SYNTHETIC Shop",
      merchantKey: "synthetic-shop",
      orderNumber: "SYN-1001",
      orderedOn: j.day(-6),
      currency: "GBP",
      totalMinor: 21_000,
      channel: "owner_statement",
      lines: [
        { lineKey: "overshirt-L", productName: "SYNTHETIC overshirt", size: "L", priceMinor: 12_000, currency: "GBP" },
        { lineKey: "knit-M", productName: "SYNTHETIC knit", size: "M", priceMinor: 9_000, currency: "GBP" },
      ],
      sourceRefs: ["owner statement (SYNTHETIC order for journey 08)"],
    });
    expect(logged.outcome).toBe("committed");
    expect(logged.summary).toMatch(/not arrived/i);
    expect(logged.summary).toMatch(/nothing is wearable yet/i);
    expect(internalCodesIn(logged.summary)).toEqual([]);
    orderId = logged.result.orderId;
    expect(logged.result.lineIds).toHaveLength(2);
    const logged1 = (await orders()).find((o) => o.orderId === orderId);
    overshirtLine = logged1.lines.find((l: any) => l.lineKey === "overshirt-L").lineId;
    knitMLine = logged1.lines.find((l: any) => l.lineKey === "knit-M").lineId;
    // On its own the order names no wardrobe record at all.
    expect(logged1.lines.map((l: any) => l.garmentId)).toEqual([null, null]);
    await exec(api(), "purchase.link_line", { orderId, lineId: overshirtLine, garmentId: overshirt });
    await exec(api(), "purchase.link_line", { orderId, lineId: knitMLine, garmentId: knitM });

    const [order] = await orders();
    expect(await orders()).toHaveLength(1);
    expect(order).toMatchObject({ orderId, merchant: "SYNTHETIC Shop", orderNumber: "SYN-1001", orderedOn: j.day(-6), currency: "GBP", totalMinor: 21_000 });
    expect(Object.fromEntries(order.lines.map((l: any) => [l.lineKey, [l.state, l.deliveredOn, l.garmentId, l.refundedMinor]]))).toEqual({
      "overshirt-L": ["ordered", null, overshirt, 0],
      "knit-M": ["ordered", null, knitM, 0],
    });

    // Ordered is not owned: the counts and the items say so.
    expect(await counts()).toMatchObject({ owned: countsBefore.owned, incoming: countsBefore.incoming + 2 });
    for (const id of [overshirt, knitM]) {
      const read = await item(id);
      expect(read.detail.garment).toMatchObject({ acquisition: "incoming", isSynthetic: true });
      expect(read.detail.totalOwnedUnits).toBe(0);
      expect(quantityIn(read.detail, "incoming")).toBe(1);
      expect(quantityIn(read.detail, "clean")).toBe(0);
      expect(read.availability.status).toBe("unavailable");
    }
  });

  it("arrival is a separate observed fact: only the owner's report makes them owned, with the real delivery date", async () => {
    for (const id of [overshirt, knitM]) {
      const arrived = await exec(api(), "assistant.report_arrival", { garmentId: id, deliveredOn: j.day(-2) });
      expect(arrived.outcome).toBe("committed");
      expect(arrived.summary).toMatch(/arrived/i);
      expect(arrived.summary).toMatch(/marked delivered/i);
      expect(internalCodesIn(arrived.summary)).toEqual([]);
    }
    expect(await counts()).toMatchObject({ owned: countsBefore.owned + 2, incoming: countsBefore.incoming });
    for (const [id, lineId] of [[overshirt, overshirtLine], [knitM, knitMLine]] as const) {
      const read = await item(id);
      expect(read.detail.garment.acquisition).toBe("owned");
      expect(read.detail.totalOwnedUnits).toBe(1);
      expect(quantityIn(read.detail, "clean")).toBe(1);
      expect(quantityIn(read.detail, "incoming")).toBe(0);
      expect(await line(orderId, lineId)).toMatchObject({ state: "delivered", deliveredOn: j.day(-2), garmentId: id });
    }
  });

  it("a return opened with sourced terms and the real delivery date has an established deadline: what it concerns, timezone, source and checked date", async () => {
    // No trigger date is sent: the service takes the real delivery date from the order line.
    openReceipt = await exec(api(), "return.open_case", {
      kind: "return",
      orderId,
      lineId: overshirtLine,
      terms: { windowDays: 30, concerns: "post", triggerEvent: "delivery", sourceRef: TERMS_URL, checkedOn: j.day(0), text: "Returns must be posted within 30 days of delivery." },
      refundExpectedMinor: 12_000,
      currency: "GBP",
      nextAction: "Decide whether to keep it",
      collectionPreference: "Drop-off at the parcel shop",
    });
    expect(openReceipt.outcome).toBe("committed");
    returnCase = openReceipt.result.caseId;
    const deadlineDate = addDays(j.day(-2), 30);
    expect(openReceipt.summary).toContain("SYNTHETIC overshirt, size L (journey 08)");
    expect(openReceipt.summary).toContain(`Deadline to post: ${deadlineDate} (Europe/London)`);
    expect(openReceipt.summary).toMatch(/stays in your wardrobe until it physically leaves/i);
    expect(internalCodesIn(openReceipt.summary)).toEqual([]);
    expect(openReceipt.undo.available).toBe(true);

    const read = await theCase(returnCase);
    expect(read).toMatchObject({ kind: "return", state: "considering", orderId, lineId: overshirtLine, garmentId: overshirt, quantity: 1, triggerDate: j.day(-2), stockDeparted: false });
    expect(read.terms).toEqual({ windowDays: 30, concerns: "post", triggerEvent: "delivery", sourceRef: TERMS_URL, checkedOn: j.day(0), text: "Returns must be posted within 30 days of delivery." });
    expect(read.deadline).toMatchObject({ status: "established", localDate: deadlineDate, timezone: LONDON, concerns: "post", reason: null });
    // The instant is the end of that day in the stated timezone (midnight in London, whatever the season).
    const at = Date.parse(read.deadline.at);
    expect(at).toBeGreaterThanOrEqual(Date.parse(`${deadlineDate}T22:59:00Z`));
    expect(at).toBeLessThanOrEqual(Date.parse(`${addDays(deadlineDate, 1)}T00:00:00Z`));
    expect(read).toMatchObject({ nextAction: "Decide whether to keep it", collectionPreference: "Drop-off at the parcel shop", labelRef: null, shipmentRef: null, retailerReceivedOn: null, exchangeIncoming: null });
    expect(read.refund).toEqual({ expectedMinor: 12_000, receivedMinor: 0, state: "none", currency: "GBP" });
  });

  it("reminders are queued seven and two days before the established deadline", async () => {
    const deadlineAt = Date.parse((await theCase(returnCase)).deadline.at);
    expect(openReceipt.result.reminders).toEqual([
      { daysBefore: 7, dueAt: new Date(deadlineAt - 7 * DAY_MS).toISOString().replace(".000Z", "Z") },
      { daysBefore: 2, dueAt: new Date(deadlineAt - 2 * DAY_MS).toISOString().replace(".000Z", "Z") },
    ]);
    expect(reminderEffects(openReceipt).map((e) => e.state)).toEqual(["pending", "pending"]);
    const stored = await api().json("GET", `/v1/commands/${openReceipt.commandId}`);
    expect(reminderEffects(stored)).toHaveLength(2);
  });

  it("without sourced terms the deadline is shown as unresolved, with the reason and no invented date", async () => {
    const opened = await exec(api(), "return.open_case", { kind: "exchange", orderId, lineId: knitMLine, reason: "Too small across the shoulders" });
    exchangeCase = opened.result.caseId;
    expect(opened.summary).toMatch(/^Exchange opened for /);
    expect(opened.summary).toMatch(/Deadline unresolved: the return terms for this purchase have not been found yet/);
    expect(opened.summary).not.toMatch(/\d{4}-\d{2}-\d{2}/);
    expect(internalCodesIn(opened.summary)).toEqual([]);
    expect(opened.result.reminders).toEqual([]);
    expect(reminderEffects(opened)).toEqual([]);
    expect((await theCase(exchangeCase)).deadline).toEqual({ status: "unresolved", at: null, localDate: null, timezone: null, concerns: null, reason: "the return terms for this purchase have not been found yet" });

    // Terms are found, but they count from dispatch and the dispatch date is not known: still no date, and no countdown.
    const termsFound = await update(exchangeCase, { terms: { windowDays: 14, concerns: "request", triggerEvent: "dispatch", sourceRef: TERMS_URL, checkedOn: j.day(0) } });
    expect(termsFound.summary).toMatch(/Deadline unresolved: the dispatch date is not known yet/);
    expect(termsFound.summary).not.toMatch(/\d{4}-\d{2}-\d{2}/);
    expect(reminderEffects(termsFound)).toEqual([]);
    expect((await theCase(exchangeCase)).deadline).toEqual({ status: "unresolved", at: null, localDate: null, timezone: null, concerns: "request", reason: "the dispatch date is not known yet" });

    // The dispatch email turns up: now, and only now, there is a deadline, and it is a deadline to request.
    const dated = await update(exchangeCase, { triggerDate: j.day(-4) });
    expect(dated.summary).toContain(`Deadline to request: ${addDays(j.day(-4), 14)} (Europe/London)`);
    expect(reminderEffects(dated)).toHaveLength(2);
    const read = await theCase(exchangeCase);
    expect(read.deadline).toMatchObject({ status: "established", localDate: addDays(j.day(-4), 14), timezone: LONDON, concerns: "request", reason: null });
    expect(read.terms).toMatchObject({ sourceRef: TERMS_URL, checkedOn: j.day(0), triggerEvent: "dispatch" });
    expect(read.triggerDate).toBe(j.day(-4));
  });

  it("a connected assistant reads the returns and orders over MCP and records the next action for the exchange", async () => {
    const returnsView = toolResult(await mcp.client.callTool({ name: "garderobe_inventory", arguments: { view: "returns" } }));
    expect(returnsView.ok).toBe(true);
    expect(returnsView.data).toMatchObject({ complete: true, total: 2 });
    expect(returnsView.data.data.returns).toEqual(await cases());
    const ordersView = toolResult(await mcp.client.callTool({ name: "garderobe_inventory", arguments: { view: "orders" } }));
    expect(ordersView.data).toMatchObject({ complete: true, total: 1 });
    expect(ordersView.data.data.orders).toEqual(await orders());

    // Whether this runs at once or waits for the owner is the server's answer; the committed state is the same.
    const before = await theCase(exchangeCase);
    const outcome = await mcpCommand(j.owner, mcp, "return.update_case", { caseId: exchangeCase, nextAction: "Ask the shop for size L" });
    expect(outcome.receipt.outcome).toBe("committed");
    expect(outcome.receipt.summary).toContain("Next: Ask the shop for size L");
    expect(internalCodesIn(outcome.receipt.summary)).toEqual([]);
    // When the owner was asked, the request said what would change (its identifier wording is journey 07's DEFECT).
    if (outcome.proposal) expect(String(outcome.proposal.summary)).toContain("Ask the shop for size L");
    const after = await theCase(exchangeCase);
    expect(after.nextAction).toBe("Ask the shop for size L");
    expect(after.version).toBe(before.version + 1);
    expect(after.deadline).toEqual(before.deadline);
  });

  it("requesting the return and getting a label remove nothing: the overshirt is still in the wardrobe", async () => {
    const requested = await update(returnCase, { state: "requested", nextAction: "Print the label" });
    expect(requested.summary).toMatch(/Return requested/);
    expect(requested.summary).toMatch(/still in your wardrobe until it physically leaves/i);
    expect(requested.undo).toEqual({ available: false, reason: "update the return again to correct it" });
    const labelled = await update(returnCase, { state: "label_ready", labelRef: "SYNTHETIC-LABEL-1", nextAction: "Take it to the parcel shop" });
    expect(labelled.summary).toMatch(/Label ready/);
    expect(labelled.summary).toMatch(/still in your wardrobe/i);
    for (const receipt of [requested, labelled]) expect(internalCodesIn(receipt.summary)).toEqual([]);

    const read = await theCase(returnCase);
    expect(read).toMatchObject({ state: "label_ready", labelRef: "SYNTHETIC-LABEL-1", nextAction: "Take it to the parcel shop", collectionPreference: "Drop-off at the parcel shop", stockDeparted: false });
    expect(read.deadline.status).toBe("established");
    const shirt = await item(overshirt);
    expect(shirt.detail.totalOwnedUnits).toBe(1);
    expect(quantityIn(shirt.detail, "clean")).toBe(1);
    expect(shirt.detail.garment.acquisition).toBe("owned");
    expect(await counts()).toMatchObject({ owned: countsBefore.owned + 2 });
  });

  it("physical departure is what removes stock; undo of that step puts the overshirt back, and it then leaves for good", async () => {
    const left = await exec(api(), "garment.retire", { garmentId: overshirt, disposition: "returned_to_seller", note: "Handed over at the parcel shop" });
    expect(left.outcome).toBe("committed");
    expect(left.summary).toMatch(/1 returned to seller; 0 still owned/);
    expect(internalCodesIn(left.summary)).toEqual([]);
    expect(left.undo.available).toBe(true);
    let shirt = await item(overshirt);
    expect(shirt.detail.totalOwnedUnits).toBe(0);
    expect(quantityIn(shirt.detail, "gone")).toBe(1);
    expect(quantityIn(shirt.detail, "clean")).toBe(0);
    expect(shirt.availability.status).toBe("unavailable");
    expect((await theCase(returnCase)).stockDeparted).toBe(true);
    expect(await counts()).toMatchObject({ owned: countsBefore.owned + 1, retired: countsBefore.retired + 1 });

    // Undo restores the stock exactly; the case itself is untouched.
    const undone = await exec(api(), "command.undo", { commandId: left.commandId });
    expect(undone.outcome).toBe("committed");
    shirt = await item(overshirt);
    expect(shirt.detail.totalOwnedUnits).toBe(1);
    expect(quantityIn(shirt.detail, "clean")).toBe(1);
    expect(quantityIn(shirt.detail, "gone")).toBe(0);
    expect(await theCase(returnCase)).toMatchObject({ state: "label_ready", stockDeparted: false });
    expect(await counts()).toMatchObject({ owned: countsBefore.owned + 2, retired: countsBefore.retired });

    await exec(api(), "garment.retire", { garmentId: overshirt, disposition: "returned_to_seller", note: "Handed over at the parcel shop" });
    const posted = await update(returnCase, { state: "posted", shipmentRef: "SYNTHETIC-TRACK-1", nextAction: "Wait for the shop to receive it" });
    expect(posted.summary).toMatch(/Marked as posted/);
    expect(posted.summary).toMatch(/Shipment recorded/);
    expect(internalCodesIn(posted.summary)).toEqual([]);
    expect(await theCase(returnCase)).toMatchObject({ state: "posted", shipmentRef: "SYNTHETIC-TRACK-1", labelRef: "SYNTHETIC-LABEL-1", stockDeparted: true });
    expect((await item(overshirt)).detail.totalOwnedUnits).toBe(0);
  });

  it("the retailer's receipt, a partial refund and then the full refund accumulate on the case", async () => {
    const received = await update(returnCase, { state: "retailer_received", retailerReceivedOn: j.day(0), nextAction: null });
    expect(received.summary).toMatch(/Retailer has received it/);
    let read = await theCase(returnCase);
    expect(read).toMatchObject({ state: "retailer_received", retailerReceivedOn: j.day(0), nextAction: null });
    expect(read.refund).toEqual({ expectedMinor: 12_000, receivedMinor: 0, state: "none", currency: "GBP" });

    const partial = await update(returnCase, { refundReceivedMinor: 5_000, refundSourceRef: "bank notice (SYNTHETIC)" });
    expect(partial.summary).toContain("GBP 50.00 of GBP 120.00");
    expect(partial.result.refund).toEqual({ expectedMinor: 12_000, receivedMinor: 5_000, state: "partial" });
    read = await theCase(returnCase);
    expect(read.refund).toEqual({ expectedMinor: 12_000, receivedMinor: 5_000, state: "partial", currency: "GBP" });
    // A partial refund never closes the case by itself.
    expect(read.state).toBe("retailer_received");

    const full = await update(returnCase, { refundReceivedMinor: 7_000, refundSourceRef: "bank notice (SYNTHETIC)" });
    expect(full.summary).toMatch(/Refund complete/);
    expect(full.summary).toContain("GBP 120.00 of GBP 120.00");
    read = await theCase(returnCase);
    expect(read.refund).toEqual({ expectedMinor: 12_000, receivedMinor: 12_000, state: "full", currency: "GBP" });
    expect(read.state).toBe("refunded");
    // Everything about the return is still together on the one case.
    expect(read).toMatchObject({ labelRef: "SYNTHETIC-LABEL-1", shipmentRef: "SYNTHETIC-TRACK-1", retailerReceivedOn: j.day(0), collectionPreference: "Drop-off at the parcel shop", stockDeparted: true });
    expect(read.deadline.status).toBe("established");
    for (const receipt of [received, partial, full]) expect(internalCodesIn(receipt.summary)).toEqual([]);
  });

  it("the shop's refund notices on the order keep its money right: partial, then refunded, and a repeated notice counts once", async () => {
    const notice = (dedupeKey: string, amountMinor: number) => exec(api(), "purchase.record_event", { orderId, event: { kind: "refund", dedupeKey, occurredAt: new Date().toISOString(), sourceRef: "refund notice (SYNTHETIC)", lineKeys: ["overshirt-L"], amountMinor } });
    expect((await notice("SYN-1001-refund-1", 5_000)).outcome).toBe("committed");
    expect(await line(orderId, overshirtLine)).toMatchObject({ state: "delivered", refundedMinor: 5_000 });
    expect((await notice("SYN-1001-refund-2", 7_000)).outcome).toBe("committed");
    expect(await line(orderId, overshirtLine)).toMatchObject({ state: "refunded", refundedMinor: 12_000 });
    const repeated = await notice("SYN-1001-refund-2", 7_000);
    expect(repeated.outcome).toBe("noop");
    expect(await line(orderId, overshirtLine)).toMatchObject({ state: "refunded", refundedMinor: 12_000 });
    // The other line of the order is untouched.
    expect(await line(orderId, knitMLine)).toMatchObject({ state: "delivered", refundedMinor: 0 });
  });

  it("an exchange links the outgoing and the incoming variant without owning either twice", async () => {
    knitL = await syntheticIncoming("SYNTHETIC knit, size L (journey 08)", "knitwear");
    const replacement = await exec(api(), "purchase.import_order", {
      merchant: "SYNTHETIC Shop",
      merchantKey: "synthetic-shop",
      orderNumber: "SYN-1002",
      orderedOn: j.day(0),
      currency: "GBP",
      channel: "owner_statement",
      lines: [{ lineKey: "knit-L", productName: "SYNTHETIC knit", size: "L", priceMinor: 9_000, currency: "GBP" }],
      sourceRefs: ["owner statement (SYNTHETIC replacement order for journey 08)"],
    });
    replacementOrderId = replacement.result.orderId;
    knitLLine = replacement.result.lineIds[0];
    await exec(api(), "purchase.link_line", { orderId: replacementOrderId, lineId: knitLLine, garmentId: knitL });
    const ownedBeforeLink = (await counts()).owned;

    // The outgoing garment cannot be named as its own replacement, and a plain return has no incoming variant.
    const self = await refused(await api().command("return.link_exchange", { caseId: exchangeCase, incomingOrderId: orderId, incomingLineId: knitMLine }));
    expect(self.status).toBe(409);
    expect(self.error.message).toMatch(/must be its own incoming record, not the garment being sent back/);
    const notAnExchange = await refused(await api().command("return.link_exchange", { caseId: returnCase, incomingOrderId: replacementOrderId, incomingLineId: knitLLine }));
    expect(notAnExchange.error.code).toBe("precondition_failed");
    expect((await theCase(exchangeCase)).exchangeIncoming).toBeNull();

    const linked = await exec(api(), "return.link_exchange", { caseId: exchangeCase, incomingOrderId: replacementOrderId, incomingLineId: knitLLine });
    expect(linked.outcome).toBe("committed");
    expect(linked.summary).toMatch(/counts as owned only once it arrives, and the outgoing piece until it leaves/);
    expect(internalCodesIn(linked.summary)).toEqual([]);

    const read = await theCase(exchangeCase);
    expect(read).toMatchObject({ kind: "exchange", garmentId: knitM, orderId, lineId: knitMLine, stockDeparted: false });
    expect(read.exchangeIncoming).toEqual({ orderId: replacementOrderId, lineId: knitLLine });
    expect((await line(replacementOrderId, knitLLine)).replaces).toEqual({ orderId, lineId: knitMLine });

    // One knit is owned (the one still here); the replacement is on order and owned zero times.
    expect((await counts()).owned).toBe(ownedBeforeLink);
    const outgoing = await item(knitM);
    expect(outgoing.detail.totalOwnedUnits).toBe(1);
    expect(quantityIn(outgoing.detail, "clean")).toBe(1);
    const incoming = await item(knitL);
    expect(incoming.detail.garment.acquisition).toBe("incoming");
    expect(incoming.detail.totalOwnedUnits).toBe(0);
    expect(incoming.availability.status).toBe("unavailable");
  });

  it("the exchange completes: the wrong size leaves, the right size arrives, and exactly one knit is owned throughout", async () => {
    await update(exchangeCase, { state: "requested" });
    expect((await item(knitM)).detail.totalOwnedUnits).toBe(1);

    await exec(api(), "garment.retire", { garmentId: knitM, disposition: "returned_to_seller" });
    await update(exchangeCase, { state: "posted", shipmentRef: "SYNTHETIC-TRACK-2" });
    expect((await item(knitM)).detail.totalOwnedUnits).toBe(0);
    expect((await item(knitL)).detail.totalOwnedUnits).toBe(0);
    expect((await theCase(exchangeCase)).stockDeparted).toBe(true);

    await exec(api(), "assistant.report_arrival", { garmentId: knitL, deliveredOn: j.day(0) });
    const done = await update(exchangeCase, { state: "exchanged", nextAction: null });
    expect(done.summary).toMatch(/Exchange complete/);
    expect(internalCodesIn(done.summary)).toEqual([]);

    const read = await theCase(exchangeCase);
    expect(read).toMatchObject({ state: "exchanged", shipmentRef: "SYNTHETIC-TRACK-2", stockDeparted: true });
    expect(read.exchangeIncoming).toEqual({ orderId: replacementOrderId, lineId: knitLLine });
    // An exchange is not a refund: no money came back and the case says so.
    expect(read.refund).toMatchObject({ receivedMinor: 0, state: "none" });
    expect((await item(knitL)).detail).toMatchObject({ totalOwnedUnits: 1 });
    expect(await line(replacementOrderId, knitLLine)).toMatchObject({ state: "delivered", deliveredOn: j.day(0), garmentId: knitL });
    // Net effect on the wardrobe: the overshirt went back, one knit replaced the other.
    expect(await counts()).toMatchObject({ owned: countsBefore.owned + 1, incoming: countsBefore.incoming, retired: countsBefore.retired + 2 });
  });

  it("a return opened by mistake is undone: the case is cancelled and the knit stays exactly as it was", async () => {
    const opened = await exec(api(), "return.open_case", {
      kind: "return",
      orderId: replacementOrderId,
      lineId: knitLLine,
      terms: { windowDays: 30, concerns: "retailer_receipt", triggerEvent: "delivery", sourceRef: TERMS_URL, checkedOn: j.day(0) },
    });
    mistakenCase = opened.result.caseId;
    expect(opened.summary).toContain(`Deadline to reach the retailer: ${addDays(j.day(0), 30)} (Europe/London)`);
    expect((await theCase(mistakenCase)).deadline).toMatchObject({ status: "established", concerns: "retailer_receipt", localDate: addDays(j.day(0), 30) });
    expect(reminderEffects(opened)).toHaveLength(2);

    const undone = await exec(api(), "command.undo", { commandId: opened.commandId });
    expect(undone.outcome).toBe("committed");
    expect(undone.summary).toMatch(/Return cancelled; the item stays as it was/);
    expect(internalCodesIn(undone.summary)).toEqual([]);
    expect((await theCase(mistakenCase)).state).toBe("cancelled");
    const knit = await item(knitL);
    expect(knit.detail.totalOwnedUnits).toBe(1);
    expect(quantityIn(knit.detail, "clean")).toBe(1);
    // An undo is not itself undone again.
    const again = await refused(await api().command("command.undo", { commandId: opened.commandId }));
    expect(again.status).toBeGreaterThanOrEqual(400);
  });

  it("the lists read the same in the app and over MCP, and say where each case stands", async () => {
    const all = await cases();
    expect(Object.fromEntries(all.map((c) => [c.caseId, c.state]))).toEqual({ [returnCase]: "refunded", [exchangeCase]: "exchanged", [mistakenCase]: "cancelled" });
    expect((await orders()).map((o) => o.orderNumber).sort()).toEqual(["SYN-1001", "SYN-1002"]);
    const returnsView = toolResult(await mcp.client.callTool({ name: "garderobe_inventory", arguments: { view: "returns" } }));
    expect(returnsView.data).toMatchObject({ complete: true, total: 3 });
    expect(returnsView.data.data.returns).toEqual(all);
    const ordersView = toolResult(await mcp.client.callTool({ name: "garderobe_inventory", arguments: { view: "orders" } }));
    expect(ordersView.data).toMatchObject({ complete: true, total: 2 });
    expect(ordersView.data.data.orders).toEqual(await orders());
  });

  it("another owner sees none of it and cannot touch the case", async () => {
    expect((await stranger.api.json("GET", "/v1/returns")).returns).toEqual([]);
    expect((await stranger.api.json("GET", "/v1/orders")).orders).toEqual([]);
    const meddle = await refused(await stranger.api.command("return.update_case", { caseId: exchangeCase, state: "cancelled" }));
    expect(meddle.status).toBe(404);
    const open = await refused(await stranger.api.command("return.open_case", { kind: "return", orderId, lineId: overshirtLine }));
    expect(open.status).toBe(404);
    expect((await theCase(exchangeCase)).state).toBe("exchanged");
  });
});
