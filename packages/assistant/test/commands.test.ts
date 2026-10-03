import { beforeAll, describe, expect, it } from "vitest";
import { all, getAvailability, getGarmentDetail, isCommandError, listInventory } from "@garderobe/domain";
import { getOrder, listComfortFeedback, listConnections, listForgetStates, listJobs, listLifecycleProjects, listMemoryConclusions, listOrders, listProducts, listResearchNotes, listReturnCases } from "../src/index.ts";
import { createWorld, setNow, type World } from "./helpers.ts";

/** The signed-in owner in the app: these tests exercise the handlers, not the conversation gate (an assistant principal cannot run them on its own say-so; see review-round3.test.ts). */
const STATEMENT = { actor: "owner" as const, channel: "ios" as const, authorization: "owner_tap" as const };

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

describe("assistant-lane commands on the shared command service (real D1, the owner's real imported wardrobe)", () => {
  let w: World;
  const p = () => w.owner.principal();
  beforeAll(async () => {
    w = await createWorld();
  });

  describe("purchases: an order is not an arrival", () => {
    const order = {
      merchant: "Drake's",
      merchantKey: "drakes",
      orderNumber: "DR-48213",
      orderedOn: "2026-09-10",
      currency: "GBP",
      lines: [
        { lineKey: "code:dr-ocbd-blue|size:16", productName: "Oxford button-down shirt", productCode: "DR-OCBD-BLUE", size: "16", colour: "Blue", priceMinor: 19500 },
        { lineKey: "code:dr-ocbd-white|size:16", productName: "Oxford button-down shirt", productCode: "DR-OCBD-WHITE", size: "16", colour: "White", priceMinor: 19500 },
      ],
      events: [{ kind: "confirmation", dedupeKey: "drakes:DR-48213:confirmation:m1", occurredAt: "2026-09-10T09:00:00Z", sourceRef: "gmail:m1" }],
      sourceRefs: ["gmail:m1"],
    };
    let orderId = "";
    let garmentId = "";

    it("logs an order once; a repeated confirmation email duplicates nothing", async () => {
      const first = await w.owner.exec("purchase.import_order", order, STATEMENT);
      expect(first.outcome).toBe("committed");
      expect(first.summary).toContain("not arrived");
      orderId = String(first.result["orderId"]);
      const again = await w.owner.exec("purchase.import_order", { ...order, events: [{ ...order.events[0]!, sourceRef: "gmail:m1" }] }, STATEMENT);
      expect(again.outcome).toBe("noop");
      const stored = (await getOrder(w.h.db, p(), orderId))!;
      // Two lines with the same product name stay two lines: a name alone is not an identity.
      expect(stored.lines).toHaveLength(2);
      expect(stored.events).toHaveLength(1);
      expect((await listOrders(w.h.db, p(), { merchantKey: "drakes" })).length).toBe(1);
    });

    it("rejects two lines sharing a key instead of merging them by name", async () => {
      await rejects(w.owner.exec("purchase.import_order", { ...order, orderNumber: "DR-X", lines: [order.lines[0], order.lines[0]] }, STATEMENT), "invalid_command");
    });

    it("a dispatch and a carrier delivery notice enrich the order without making anything wearable", async () => {
      const before = (await listInventory(w.h.db, p())).counts;
      const incoming = await w.owner.exec("garment.create", { name: "Drake's oxford button-down, blue", category: "shirt", roles: ["top"], careChannel: "service", acquisition: "incoming", quantity: 1, source: { kind: "receipt", ref: "gmail:m1" } }, STATEMENT);
      garmentId = String(incoming.result["garmentId"]);
      const stored = (await getOrder(w.h.db, p(), orderId))!;
      const line = stored.lines.find((l) => l.productCode === "DR-OCBD-BLUE")!;
      await w.owner.exec("purchase.link_line", { orderId, lineId: line.lineId, garmentId }, STATEMENT);
      const dispatch = await w.owner.exec("purchase.record_event", { orderId, event: { kind: "dispatch", dedupeKey: "d1", occurredAt: "2026-09-11T09:00:00Z", sourceRef: "gmail:m2", lineKeys: [line.lineKey] } }, STATEMENT);
      expect(dispatch.summary).toContain("not counted as arrived");
      await w.owner.exec("purchase.record_event", { orderId, event: { kind: "delivery", dedupeKey: "c1", occurredAt: "2026-09-12T09:00:00Z", sourceRef: "gmail:m3", lineKeys: [line.lineKey] } }, STATEMENT);
      // The same dispatch email read twice is recorded once.
      expect((await w.owner.exec("purchase.record_event", { orderId, event: { kind: "dispatch", dedupeKey: "d1", occurredAt: "2026-09-11T09:00:00Z", sourceRef: "gmail:m2", lineKeys: [line.lineKey] } }, STATEMENT)).outcome).toBe("noop");
      const after = (await getOrder(w.h.db, p(), orderId))!;
      expect(after.lines.find((l) => l.lineId === line.lineId)!.state).toBe("dispatched");
      const availability = await getAvailability(w.h.db, p());
      const a = availability.garments.find((g) => g.garmentId === garmentId)!;
      expect(a.hardExcluded).toBe(true);
      expect((await listInventory(w.h.db, p())).counts.owned).toBe(before.owned);
      // A second garment record for the same line would double the ownership.
      const other = await w.garment("California plaid");
      await rejects(w.owner.exec("purchase.link_line", { orderId, lineId: line.lineId, garmentId: other.garmentId }, STATEMENT), "conflict");
    });

    it("only the owner's arrival observation makes it owned; the order line then records the real delivery date", async () => {
      await w.owner.exec("garment.receive", { garmentId }, STATEMENT);
      const stored = (await getOrder(w.h.db, p(), orderId))!;
      const line = stored.lines.find((l) => l.garmentId === garmentId)!;
      await w.owner.exec("purchase.mark_delivered", { orderId, lineId: line.lineId, deliveredOn: "2026-09-13" }, STATEMENT);
      const detail = await getGarmentDetail(w.h.db, p(), garmentId);
      expect(detail.garment.acquisition).toBe("owned");
      expect((await getOrder(w.h.db, p(), orderId))!.lines.find((l) => l.lineId === line.lineId)!.deliveredOn).toBe("2026-09-13");
    });

    it("a remake is linked to the original line and takes over its garment record instead of doubling ownership", async () => {
      const total = (await listInventory(w.h.db, p(), { includeDisposed: true })).total;
      const remake = await w.owner.exec(
        "purchase.import_order",
        { merchant: "Drake's", merchantKey: "drakes", orderNumber: "DR-48213-R", lines: [{ lineKey: "code:dr-ocbd-blue|size:16.5", productName: "Oxford button-down shirt", productCode: "DR-OCBD-BLUE", size: "16.5", replacesLineKey: "code:dr-ocbd-blue|size:16" }], replaces: { merchantKey: "drakes", orderNumber: "DR-48213" }, sourceRefs: ["gmail:m9"] },
        STATEMENT,
      );
      const stored = (await getOrder(w.h.db, p(), String(remake.result["orderId"])))!;
      expect(stored.replacesOrderId).toBe(orderId);
      expect(stored.lines[0]!.garmentId).toBe(garmentId);
      expect(stored.lines[0]!.replaces?.orderId).toBe(orderId);
      expect((await getOrder(w.h.db, p(), orderId))!.lines.find((l) => l.productCode === "DR-OCBD-BLUE")!.state).toBe("exchanged");
      expect((await listInventory(w.h.db, p(), { includeDisposed: true })).total).toBe(total);
      await rejects(w.owner.exec("purchase.import_order", { merchant: "X", merchantKey: "x", orderNumber: "1", lines: [{ lineKey: "a", productName: "A" }], replaces: { merchantKey: "x", orderNumber: "missing" } }, STATEMENT), "not_found");
    });

    it("a partial refund keeps its monetary state and never changes stock", async () => {
      const stored = (await getOrder(w.h.db, p(), orderId))!;
      const white = stored.lines.find((l) => l.productCode === "DR-OCBD-WHITE")!;
      await w.owner.exec("purchase.record_event", { orderId, event: { kind: "refund", dedupeKey: "r1", occurredAt: "2026-09-14T09:00:00Z", sourceRef: "gmail:m4", lineKeys: [white.lineKey], amountMinor: 5000 } }, STATEMENT);
      let line = (await getOrder(w.h.db, p(), orderId))!.lines.find((l) => l.lineId === white.lineId)!;
      expect(line.refundedMinor).toBe(5000);
      expect(line.state).toBe("ordered");
      await w.owner.exec("purchase.record_event", { orderId, event: { kind: "refund", dedupeKey: "r2", occurredAt: "2026-09-14T10:00:00Z", sourceRef: "gmail:m5", lineKeys: [white.lineKey], amountMinor: 14500 } }, STATEMENT);
      line = (await getOrder(w.h.db, p(), orderId))!.lines.find((l) => l.lineId === white.lineId)!;
      expect(line.state).toBe("refunded");
      await rejects(w.owner.exec("purchase.record_event", { orderId, event: { kind: "refund", dedupeKey: "r3", occurredAt: "2026-09-14T10:00:00Z", sourceRef: "x", lineKeys: ["no-such-line"] } }, STATEMENT), "not_found");
    });
  });

  describe("returns and exchanges", () => {
    const terms = { windowDays: 14, concerns: "post", triggerEvent: "delivery", sourceRef: "https://shop.example/returns#order-DR-48213", checkedOn: "2026-09-15" };

    it("shows an unknown deadline as unresolved research, never a guessed countdown, and schedules no reminder", async () => {
      const g = await w.garment("Clark oxford — beige");
      const r = await w.owner.exec("return.open_case", { kind: "return", garmentId: g.garmentId }, STATEMENT);
      expect((r.result["deadline"] as { status: string }).status).toBe("unresolved");
      expect(r.effects).toHaveLength(0);
      expect(r.summary).toContain("stays in your wardrobe");
      // Sourced terms without the real trigger date are still unresolved.
      const u = await w.owner.exec("return.update_case", { caseId: r.result["caseId"], terms }, STATEMENT);
      expect((u.result["deadline"] as { status: string; reason: string }).status).toBe("unresolved");
      expect((u.result["deadline"] as { reason: string }).reason).toContain("delivery date");
      const detail = await getGarmentDetail(w.h.db, p(), g.garmentId);
      expect(detail.garment.acquisition).toBe("owned");
    });

    it("establishes a deadline from sourced terms and the real delivery date, with deduplicated seven- and two-day reminders", async () => {
      setNow(w, "2026-09-15T08:00:00Z");
      const g = await w.garment("Clark oxford — evergreen");
      const r = await w.owner.exec("return.open_case", { kind: "return", garmentId: g.garmentId, terms, triggerDate: "2026-09-13", refundExpectedMinor: 11094, currency: "GBP" }, STATEMENT);
      const deadline = r.result["deadline"] as { status: string; localDate: string; at: string; timezone: string };
      expect(deadline).toMatchObject({ status: "established", localDate: "2026-09-27", timezone: "Europe/London" });
      // End of 27 September in London (BST) is 23:00 UTC.
      expect(deadline.at).toBe("2026-09-27T23:00:00Z");
      const reminders = await all<{ operation_key: string; available_at: string; state: string }>(w.h.db, "SELECT operation_key, available_at, state FROM effects WHERE user_id = ? AND kind = 'notification.return_reminder' AND target_key = ? ORDER BY available_at", w.owner.userId, `return:${r.result["caseId"]}`);
      expect(reminders.map((x) => x.available_at)).toEqual(["2026-09-20T23:00:00Z", "2026-09-25T23:00:00Z"]);
      // Updating the case again does not queue the same reminders twice.
      await w.owner.exec("return.update_case", { caseId: r.result["caseId"], nextAction: "Print the label" }, STATEMENT);
      const again = await all(w.h.db, "SELECT 1 FROM effects WHERE user_id = ? AND kind = 'notification.return_reminder' AND target_key = ?", w.owner.userId, `return:${r.result["caseId"]}`);
      expect(again).toHaveLength(2);

      // Requesting the return removes nothing; a partial refund stays partial; posting stops the reminders.
      const requested = await w.owner.exec("return.update_case", { caseId: r.result["caseId"], state: "requested" }, STATEMENT);
      expect(requested.summary).toContain("still in your wardrobe");
      const part = await w.owner.exec("return.update_case", { caseId: r.result["caseId"], refundReceivedMinor: 5000, refundSourceRef: "gmail:r1" }, STATEMENT);
      expect((part.result["refund"] as { state: string }).state).toBe("partial");
      expect(part.result["state"]).toBe("requested");
      await w.owner.exec("garment.retire", { garmentId: g.garmentId, disposition: "returned_to_seller" }, STATEMENT);
      await w.owner.exec("return.update_case", { caseId: r.result["caseId"], state: "posted", shipmentRef: "RM123" }, STATEMENT);
      const pending = await all(w.h.db, "SELECT 1 FROM effects WHERE user_id = ? AND kind = 'notification.return_reminder' AND target_key = ? AND state = 'pending'", w.owner.userId, `return:${r.result["caseId"]}`);
      expect(pending).toHaveLength(0);
      const full = await w.owner.exec("return.update_case", { caseId: r.result["caseId"], refundReceivedMinor: 6094 }, STATEMENT);
      expect(full.result["state"]).toBe("refunded");
      const view = (await listReturnCases(w.h.db, p())).find((c) => c.caseId === r.result["caseId"])!;
      expect(view.refund).toMatchObject({ receivedMinor: 11094, state: "full" });
      expect(view.stockDeparted).toBe(true);
    });

    it("an exchange links the incoming variant without duplicating ownership", async () => {
      const g = await w.garment("Brushed wool — Subalpino navy");
      const before = (await listInventory(w.h.db, p())).counts.owned;
      const incoming = await w.owner.exec("purchase.import_order", { merchant: "Proper Cloth", merchantKey: "propercloth", orderNumber: "PC-EX-1", lines: [{ lineKey: "code:pcf4901|size:mtm2", productName: "Subalpino navy brushed wool shirt", productCode: "PCF4901", size: "MTM rev 2" }] }, STATEMENT);
      const c = await w.owner.exec("return.open_case", { kind: "exchange", garmentId: g.garmentId }, STATEMENT);
      const linked = await w.owner.exec("return.link_exchange", { caseId: c.result["caseId"], incomingOrderId: incoming.result["orderId"], incomingLineId: (incoming.result["lineIds"] as string[])[0] }, STATEMENT);
      expect(linked.summary).toContain("only once it arrives");
      expect((await listInventory(w.h.db, p())).counts.owned).toBe(before);
      const view = (await listReturnCases(w.h.db, p())).find((x) => x.caseId === c.result["caseId"])!;
      expect(view.exchangeIncoming).not.toBeNull();
      expect(view.stockDeparted).toBe(false);
    });
  });

  describe("lifecycle projects", () => {
    it("is all-or-nothing: one unknown piece opens nothing and invents nothing", async () => {
      const a = await w.garment("California plaid");
      const total = (await listInventory(w.h.db, p(), { includeDisposed: true })).total;
      await rejects(w.owner.exec("lifecycle.open_project", { kind: "consignment", title: "Autumn consignment", items: [{ garmentId: a.garmentId }, { garmentId: "gmt_does_not_exist" }] }, STATEMENT), "not_found");
      expect(await listLifecycleProjects(w.h.db, p())).toHaveLength(0);
      expect((await listInventory(w.h.db, p(), { includeDisposed: true })).total).toBe(total);
    });

    it("runs a consignment from selection to pickup and proceeds; a drafted listing never means the item left", async () => {
      const a = await w.garment("California plaid");
      const open = await w.owner.exec("lifecycle.open_project", { kind: "consignment", title: "Autumn consignment", items: [{ garmentId: a.garmentId }], destination: "Marrkt", nextAction: "Match photographs", details: { preference: "collection over couriers" } }, STATEMENT);
      const projectId = String(open.result["projectId"]);
      await w.owner.exec("lifecycle.record_event", { projectId, kind: "copy_drafted", detail: { copy: "Proper Cloth plaid, MTM" } }, STATEMENT);
      await w.owner.exec("lifecycle.record_event", { projectId, kind: "form_prepared", nextAction: "Submit when you say so" }, STATEMENT);
      expect((await getGarmentDetail(w.h.db, p(), a.garmentId)).garment.acquisition).toBe("owned");
      // Submitting needs the owner's authorization for this concrete action.
      await rejects(w.owner.exec("lifecycle.record_event", { projectId, kind: "submission_attempted", externalOperationKey: "marrkt:form:1" }, STATEMENT), "forbidden");
      await w.owner.exec("lifecycle.authorize_action", { projectId, action: "submit_listing", scope: "Marrkt consignment form for this project", ownerQuote: "go ahead and submit the Marrkt form" }, STATEMENT);
      await w.owner.exec("lifecycle.record_event", { projectId, kind: "submission_attempted", externalOperationKey: "marrkt:form:1" }, STATEMENT);
      await w.owner.exec("lifecycle.record_event", { projectId, kind: "submission_uncertain", externalOperationKey: "marrkt:form:1" }, STATEMENT);
      // An ambiguous outcome is reconciled before another attempt.
      await rejects(w.owner.exec("lifecycle.record_event", { projectId, kind: "submission_attempted", externalOperationKey: "marrkt:form:2" }, STATEMENT), "precondition_failed");
      await w.owner.exec("lifecycle.record_event", { projectId, kind: "submission_confirmed", externalOperationKey: "marrkt:form:1" }, STATEMENT);
      // The project can be resumed from its record at any point.
      const resumed = (await listLifecycleProjects(w.h.db, p())).find((x) => x.projectId === projectId)!;
      expect(resumed.events.map((e) => e.kind)).toEqual(["opened", "copy_drafted", "form_prepared", "submission_attempted", "submission_uncertain", "submission_confirmed"]);
      expect(resumed.authorizations).toHaveLength(1);
      expect(resumed.details["preference"]).toBe("collection over couriers");
      // Pickup: the stock leaves through the ledger's own command, then the project records it and the proceeds.
      await w.owner.exec("garment.retire", { garmentId: a.garmentId, disposition: "sold" }, STATEMENT);
      await w.owner.exec("lifecycle.record_event", { projectId, kind: "pickup_completed" }, STATEMENT);
      await w.owner.exec("lifecycle.record_event", { projectId, kind: "proceeds_recorded", garmentIds: [a.garmentId], proceedsMinor: 4200, currency: "GBP", state: "completed" }, STATEMENT);
      const done = (await listLifecycleProjects(w.h.db, p())).find((x) => x.projectId === projectId)!;
      expect(done.state).toBe("completed");
      expect(done.items[0]).toMatchObject({ state: "left", proceedsMinor: 4200, currency: "GBP" });
      expect((await getGarmentDetail(w.h.db, p(), a.garmentId)).garment.acquisition).toBe("disposed");
    });
  });

  describe("comfort feedback, memory and forgetting", () => {
    it("records one discomfort report against its garment and context without widening it", async () => {
      const shoe = await w.garment("990v4");
      const r = await w.owner.exec("feedback.record", { text: "these hurt after an hour of walking", kind: "pain", garmentIds: [shoe.garmentId], activity: "walking" }, STATEMENT);
      expect(r.summary).toContain("that context only");
      expect(r.summary).not.toContain("hurt after an hour"); // the owner's wording stays out of the receipt
      const notes = await listComfortFeedback(w.h.db, p(), { garmentIds: [shoe.garmentId] });
      expect(notes[0]).toMatchObject({ pain: true, scope: null, activity: "walking", wearingDate: null, layer: null });
      // No restriction, no planning change, no ban was created by the report.
      const detail = await getGarmentDetail(w.h.db, p(), shoe.garmentId);
      expect(detail.garment.planningPolicy).toBe("normal");
      await rejects(w.owner.exec("feedback.record", { text: "x", kind: "scratchy", garmentIds: ["gmt_nope"] }, STATEMENT), "not_found");
      const undone = await w.owner.exec("command.undo", { commandId: r.commandId }, STATEMENT);
      expect(undone.outcome).toBe("committed");
      expect(await listComfortFeedback(w.h.db, p(), { garmentIds: [shoe.garmentId] })).toHaveLength(0);
    });

    it("keeps a model's extraction as a candidate until the owner confirms it", async () => {
      await rejects(w.owner.exec("memory.record_conclusion", { kind: "preference", text: "Prefers a 46 everywhere", speaker: "assistant", sourceMessageIds: ["msg_x"], status: "active" }, STATEMENT), "forbidden");
      const c = await w.owner.exec("memory.record_conclusion", { kind: "fit_judgement", text: "Drake's 46 chore fits with room for a sweater", speaker: "assistant", sourceMessageIds: ["msg_x"], premises: [{ kind: "measurement", ref: "chest", value: "44in" }] }, STATEMENT);
      expect(c.result["status"]).toBe("candidate");
      expect(await listMemoryConclusions(w.h.db, p(), { statuses: ["active"] })).toHaveLength(0);
      await w.owner.exec("memory.set_status", { conclusionId: c.result["conclusionId"], status: "active", correctedText: "Drake's 46 chore fits over a shirt only" }, STATEMENT);
      const active = await listMemoryConclusions(w.h.db, p(), { statuses: ["active"] });
      expect(active[0]!.text).toBe("Drake's 46 chore fits over a shirt only");
      expect(active[0]!.version).toBe(2);
    });

    it("forgetting hides a source at once, erases the ledger's own copies, and never reports suppression as completed erasure", async () => {
      const note = await w.owner.exec("research.save_note", { topic: "French chore coat chronology", body: "Private notes about the bleu de travail.", claims: [{ text: "Worn by railway workers by 1900", status: "unsupported", uncertainty: "no primary source found" }] }, STATEMENT);
      const noteId = String(note.result["noteId"]);
      const f = await w.owner.exec("conversation.forget_source", { sourceKind: "research_note", sourceIds: [noteId] }, STATEMENT);
      expect(f.undo.available).toBe(false);
      expect(await listResearchNotes(w.h.db, p())).toHaveLength(0);
      const raw = JSON.stringify(await all(w.h.db, "SELECT * FROM research_notes WHERE user_id = ?", w.owner.userId)) + JSON.stringify(await all(w.h.db, "SELECT payload_json FROM commands WHERE user_id = ? AND command_id = ?", w.owner.userId, note.commandId));
      expect(raw).not.toContain("bleu de travail");
      let state = (await listForgetStates(w.h.db, p())).find((s) => s.sourceId === noteId)!;
      expect(state.state).toBe("suppressed");
      expect(state.pendingStores).toEqual(["ai_search"]);
      await rejects(w.owner.exec("research.save_note", { noteId, topic: "again", body: "rewritten" }, STATEMENT), "forbidden");
      await w.owner.exec("conversation.confirm_erasure", { sourceKind: "research_note", sourceIds: [noteId], store: "ai_search" }, { actor: "system", channel: "system", authorization: "system_schedule" });
      state = (await listForgetStates(w.h.db, p())).find((s) => s.sourceId === noteId)!;
      expect(state.state).toBe("erased");
    });

    it("a claim marked supported must cite a passage", async () => {
      await rejects(w.owner.exec("research.save_note", { topic: "t", body: "b", claims: [{ text: "Invented lineage", status: "supported" }] }, STATEMENT), "invalid_command");
    });
  });

  describe("shopping candidates, connections and background jobs", () => {
    it("a shopping candidate is never owned stock, and 'available' needs the exact observed size and colour", async () => {
      const total = (await listInventory(w.h.db, p(), { includeDisposed: true })).total;
      const product = await w.owner.exec("product.record", { name: "Shetland crewneck", maker: "Harley", url: "https://shop.example/harley-crew" }, STATEMENT);
      const productId = String(product.result["productId"]);
      await rejects(w.owner.exec("product.record_observation", { productId, observedAt: "2026-09-15T08:00:00Z", checkedUrl: "https://shop.example/harley-crew", availability: "available", method: "tavily_basic", completeness: "partial" }, STATEMENT), "invalid_command");
      await w.owner.exec("product.record_observation", { productId, observedAt: "2026-09-15T08:00:00Z", checkedUrl: "https://shop.example/harley-crew?size=44", availability: "available", size: "44", colour: "Moss", priceMinor: 14500, currency: "GBP", method: "browser_interactive", completeness: "complete" }, STATEMENT);
      const view = (await listProducts(w.h.db, p()))[0]!;
      expect(view.owned).toBe(false);
      expect(view.observations[0]).toMatchObject({ availability: "available", size: "44", colour: "Moss" });
      expect((await listInventory(w.h.db, p(), { includeDisposed: true })).total).toBe(total);
    });

    it("registers a connection without a credential, and a revoked connection loses its tool groups and secret reference", async () => {
      await rejects(w.owner.exec("connection.register", { kind: "mcp", label: "Bad", endpoint: "https://127.0.0.1/mcp", namespace: "bad" }, STATEMENT), "invalid_command");
      await rejects(w.owner.exec("connection.register", { kind: "tavily", label: "Tavily", endpoint: "https://mcp.tavily.com/mcp/?tavilyApiKey=tvly-abcdefghijkl123", namespace: "tavily" }, STATEMENT), "invalid_command");
      const c = await w.owner.exec("connection.register", { kind: "tavily", label: "Tavily", endpoint: "https://mcp.tavily.com/mcp/", namespace: "tavily", secretRef: "TAVILY_API_KEY" }, STATEMENT);
      const connectionId = String(c.result["connectionId"]);
      await w.owner.exec("connection.record_discovery", { connectionId, protocolVersion: "2026-07-28", schemaDigest: "a".repeat(64), tools: [{ name: "tavily_search", enabled: true, group: "search" }, { name: "tavily_research", enabled: false, disabledReason: "provider-side inference is not routed through Garderobe's AI Gateway", group: "research" }] }, { actor: "system", channel: "system", authorization: "system_schedule" });
      await w.owner.exec("connection.set_tool_groups", { connectionId, enabledGroups: ["search"] }, STATEMENT);
      await rejects(w.owner.exec("connection.set_tool_groups", { connectionId, enabledGroups: ["shell"] }, STATEMENT), "not_found");
      await w.owner.exec("connection.set_status", { connectionId, status: "revoked" }, STATEMENT);
      const view = (await listConnections(w.h.db, p()))[0]!;
      expect(view).toMatchObject({ status: "revoked", enabledGroups: [], secretRef: null });
      await rejects(w.owner.exec("connection.set_status", { connectionId, status: "connected" }, STATEMENT), "forbidden");
    });

    it("a background job reports coverage honestly, delivers its result once, and a late step after Stop changes nothing", async () => {
      const j = await w.owner.exec("job.create", { kind: "email_investigation", title: "Everything bought from Drake's", params: { merchant: "drakes" } }, STATEMENT);
      const jobId = String(j.result["jobId"]);
      const SYSTEM = { actor: "system" as const, channel: "system" as const, authorization: "system_schedule" as const };
      await w.owner.exec("job.update", { jobId, state: "running", coverage: { from: "2025-01-01", to: "2025-06-30", completion: "partial", resumeToken: "p2" }, committedCommandIds: ["cmd_a"] }, SYSTEM);
      const stopped = await w.owner.exec("job.update", { jobId, state: "cancelled" }, STATEMENT);
      expect(stopped.summary).toContain("already made stay in place");
      const late = await w.owner.exec("job.update", { jobId, state: "completed", committedCommandIds: ["cmd_b"] }, SYSTEM);
      expect(late.outcome).toBe("noop");
      const job = (await listJobs(w.h.db, p()))[0]!;
      expect(job).toMatchObject({ state: "cancelled", committedCommandIds: ["cmd_a"], coverage: { completion: "partial" } });
      const deliveries = await all(w.h.db, "SELECT 1 FROM outbox WHERE user_id = ? AND topic = 'conversation.deliver' AND entity_id = ?", w.owner.userId, jobId);
      expect(deliveries).toHaveLength(1);
    });
  });
});
