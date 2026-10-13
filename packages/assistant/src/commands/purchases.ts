import { ASSISTANT_COMMANDS as C } from "@garderobe/contracts/ext/assistant";
import { CommandError, all, define, first, json, stmt, type CommandContext, type CommandPlan, type Stmt } from "@garderobe/domain";
import { NO_UNDO, plural, requireGarments, named } from "./common.ts";
import { mergePlans, subPlan, subUndo } from "./composite.ts";

interface OrderRow {
  order_id: string;
  version: number;
  merchant: string;
  order_number: string;
  source_refs_json: string;
}
interface LineRow {
  line_id: string;
  line_key: string;
  product_name: string;
  state: string;
  garment_id: string | null;
  quantity: number;
  price_minor: number | null;
  refunded_minor: number;
  delivered_on?: string | null;
  arrival_estimate?: string | null;
  currency?: string | null;
  size?: string | null;
  colour?: string | null;
}

const LINE_STATE_FOR_EVENT: Record<string, string | null> = {
  confirmation: null,
  dispatch: "dispatched",
  // A carrier delivery notice is evidence, not the owner's arrival observation: the line stays dispatched
  // until `purchase.mark_delivered` follows the owner's `garment.receive`.
  delivery: "dispatched",
  refund: "refunded",
  cancellation: "cancelled",
  remake: null,
  return: "returned",
};

const FORWARD_ONLY = ["ordered", "dispatched", "delivered"];

function nextLineState(current: string, eventKind: string): string {
  const target = LINE_STATE_FOR_EVENT[eventKind];
  if (!target) return current;
  // Never move a delivered line back to dispatched because an older email was read later.
  if (FORWARD_ONLY.includes(target) && FORWARD_ONLY.indexOf(current) > FORWARD_ONLY.indexOf(target)) return current;
  if (target === "dispatched" && !FORWARD_ONLY.includes(current)) return current;
  return target;
}

async function loadOrder(ctx: CommandContext, orderId: string): Promise<OrderRow> {
  const row = await first<OrderRow>(ctx.db, "SELECT order_id, version, merchant, order_number, source_refs_json FROM orders WHERE user_id = ? AND order_id = ?", ctx.userId, orderId);
  if (!row) throw new CommandError("not_found", `no order '${orderId}'; nothing was written`, { orderId });
  return row;
}

async function loadLines(ctx: CommandContext, orderId: string): Promise<LineRow[]> {
  return all<LineRow>(ctx.db, "SELECT line_id, line_key, product_name, state, garment_id, quantity, price_minor, refunded_minor, delivered_on, arrival_estimate, currency, size, colour FROM order_lines WHERE user_id = ? AND order_id = ? ORDER BY line_id", ctx.userId, orderId);
}

/** Line states from which an owner's arrival observation can still be recorded on the order. */
export const DELIVERABLE_LINE_STATES = ["ordered", "dispatched"] as const;

/** Splits a refund across lines in minor units without losing the remainder: the first lines take one extra unit. */
export function refundShares(amountMinor: number, count: number): number[] {
  if (count <= 0) return [];
  const base = Math.floor(amountMinor / count);
  const remainder = amountMinor - base * count;
  return Array.from({ length: count }, (_, i) => base + (i < remainder ? 1 : 0));
}

function eventStatements(
  ctx: CommandContext,
  orderId: string,
  lines: { line_id: string; line_key: string; state: string; price_minor: number | null; refunded_minor: number }[],
  event: { kind: string; dedupeKey: string; occurredAt: string; sourceRef: string; lineKeys: string[]; amountMinor: number | null },
): { statements: Stmt[]; lineIds: string[]; unknownLineKeys: string[] } {
  const byKey = new Map(lines.map((l) => [l.line_key, l]));
  // A line named twice is one line: it receives one share of a refund and is listed once on the event.
  const lineKeys = [...new Set(event.lineKeys)];
  const unknownLineKeys = lineKeys.filter((k) => !byKey.has(k));
  // An event with no named lines applies to the whole order.
  const targets = lineKeys.length > 0 ? lineKeys.map((k) => byKey.get(k)).filter((l): l is NonNullable<typeof l> => !!l) : lines;
  const statements: Stmt[] = [
    stmt(
      "INSERT INTO order_events (user_id, event_id, order_id, kind, dedupe_key, occurred_at, source_ref, line_ids_json, amount_minor, command_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ctx.userId, ctx.newId("oev"), orderId, event.kind, event.dedupeKey, event.occurredAt, event.sourceRef, JSON.stringify(targets.map((l) => l.line_id)), event.amountMinor, ctx.commandId,
    ),
  ];
  const shares = event.kind === "refund" && event.amountMinor !== null ? refundShares(event.amountMinor, targets.length) : [];
  for (const [index, line] of targets.entries()) {
    let state = nextLineState(line.state, event.kind);
    let refunded = line.refunded_minor;
    if (event.kind === "refund" && event.amountMinor !== null) {
      // A partial refund keeps its monetary state; only a refund covering the line price marks it refunded.
      const share = shares[index] ?? 0;
      refunded = line.refunded_minor + share;
      if (line.price_minor !== null && refunded < line.price_minor) state = line.state;
    }
    if (state !== line.state || refunded !== line.refunded_minor) {
      statements.push(stmt("UPDATE order_lines SET state = ?, refunded_minor = ? WHERE user_id = ? AND order_id = ? AND line_id = ?", state, refunded, ctx.userId, orderId, line.line_id));
      line.state = state;
      line.refunded_minor = refunded;
    }
  }
  return { statements, lineIds: targets.map((l) => l.line_id), unknownLineKeys };
}

/**
 * "Log the order". Deduplicated by merchant + order number + line key: a repeated confirmation merges,
 * a dispatch enriches, a remake links to its original. Nothing here creates wearable stock.
 */
export const purchaseImportOrder = define({
  type: "purchase.import_order",
  schema: C["purchase.import_order"],
  class: "edit",
  requiredScope: "write",
  allowedAuthorizations: ["owner_tap", "owner_statement", "standing_policy", "data_import"],
  async plan(ctx, p) {
    const keys = p.lines.map((l) => l.lineKey);
    if (new Set(keys).size !== keys.length) throw new CommandError("invalid_command", "two lines of this order share a line key; a product name alone does not identify a line", { keys });
    const replacing = p.lines.map((l) => l.replacesLineKey).filter((k): k is string => !!k);
    if (new Set(replacing).size !== replacing.length) throw new CommandError("invalid_command", "two lines of this order replace the same original line; one purchase can be remade only once per order", { replacesLineKeys: replacing });

    const existing = await first<OrderRow>(ctx.db, "SELECT order_id, version, merchant, order_number, source_refs_json FROM orders WHERE user_id = ? AND merchant_key = ? AND order_number = ?", ctx.userId, p.merchantKey, p.orderNumber);
    const orderId = existing?.order_id ?? ctx.newId("ord");

    let replacesOrderId: string | null = null;
    let replacesOrderVersion = 0;
    let replacedLines: LineRow[] = [];
    if (p.replaces) {
      const original = await first<{ order_id: string; version: number }>(ctx.db, "SELECT order_id, version FROM orders WHERE user_id = ? AND merchant_key = ? AND order_number = ?", ctx.userId, p.replaces.merchantKey, p.replaces.orderNumber);
      if (!original) throw new CommandError("not_found", `the order this one replaces (${p.replaces.orderNumber}) is not recorded; log it first so ownership is not doubled`, { replaces: p.replaces });
      if (existing && original.order_id === existing.order_id) throw new CommandError("invalid_command", "an order cannot replace itself; nothing was written", { replaces: p.replaces });
      replacesOrderId = original.order_id;
      replacesOrderVersion = original.version;
      replacedLines = await loadLines(ctx, original.order_id);
    }
    let tookOverOriginal = false;

    const statements: Stmt[] = [];
    const currentLines = existing ? await loadLines(ctx, orderId) : [];
    const knownKeys = new Map(currentLines.map((l) => [l.line_key, l]));
    const working = currentLines.map((l) => ({ ...l }));
    const addedLines: { lineId: string; lineKey: string; productName: string }[] = [];
    // Incoming wardrobe records asked for with the order: planned by the foundation's own garment.create and
    // committed in this same command, so an order never lands without the records it was confirmed with.
    const incomingByKey = new Map(p.incoming.map((i) => [i.lineKey, i]));
    const garmentPlans: CommandPlan[] = [];
    const createdGarments: { lineId: string; garmentId: string }[] = [];

    if (!existing) {
      statements.push(
        stmt(
          "INSERT INTO orders (user_id, order_id, version, merchant, merchant_key, order_number, ordered_on, currency, total_minor, channel, replaces_order_id, source_refs_json, created_at, updated_at) VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
          ctx.userId, orderId, p.merchant, p.merchantKey, p.orderNumber, p.orderedOn, p.currency, p.totalMinor, p.channel, replacesOrderId, JSON.stringify([...new Set(p.sourceRefs)]), ctx.now, ctx.now,
        ),
      );
    }
    let enrichedLines = 0;
    let updatedEstimateLines = 0;
    let linkedExisting = 0;
    for (const line of p.lines) {
      const known = knownKeys.get(line.lineKey);
      if (known) {
        // Enrich missing facts or update a changed arrival estimate; a repeated import never duplicates a line.
        const gainedMissing =
          (line.arrivalEstimate != null && known.arrival_estimate == null) ||
          (line.priceMinor != null && known.price_minor == null) ||
          (line.currency != null && known.currency == null) ||
          (line.size != null && known.size == null) ||
          (line.colour != null && known.colour == null);
        const changedEstimate =
          line.arrivalEstimate != null && known.arrival_estimate != null && line.arrivalEstimate !== known.arrival_estimate;
        const enriches = gainedMissing || changedEstimate;
        if (enriches) {
          if (gainedMissing) enrichedLines++;
          else updatedEstimateLines++;
          statements.push(
            stmt(
              "UPDATE order_lines SET arrival_estimate = COALESCE(?, arrival_estimate), price_minor = COALESCE(price_minor, ?), currency = COALESCE(currency, ?), size = COALESCE(size, ?), colour = COALESCE(colour, ?) WHERE user_id = ? AND order_id = ? AND line_key = ?",
              line.arrivalEstimate, line.priceMinor, line.currency, line.size, line.colour, ctx.userId, orderId, line.lineKey,
            ),
          );
          // Later events of this same import read the line as it will be: a price supplied now makes a partial
          // refund partial, not a full one.
          const w = working.find((x) => x.line_id === known.line_id);
          if (w && w.price_minor == null && line.priceMinor != null) w.price_minor = line.priceMinor;
        }
        // A line logged earlier without its incoming record gets the record the owner asked for now, but only
        // while the piece is still on its way: a delivered, cancelled, refunded, returned or exchanged line
        // (whose ownership has ended or moved to its replacement) never gets a new incoming garment.
        const wantedLater = incomingByKey.get(line.lineKey);
        if (wantedLater && !known.garment_id && (known.state === "ordered" || known.state === "dispatched")) {
          const created = await subPlan(ctx, "garment.create", {
            name: known.product_name, category: wantedLater.category, roles: wantedLater.roles, careChannel: wantedLater.careChannel, colour: line.colour ?? known.colour ?? null, size: line.size ?? known.size ?? null, maker: wantedLater.maker ?? p.merchant,
            acquisition: "incoming", quantity: known.quantity, source: { kind: "receipt", ref: `order:${orderId}` },
          });
          const garmentId = String(created.result?.["garmentId"] ?? "");
          if (!garmentId) throw new CommandError("internal", "the incoming record could not be planned; nothing was written");
          garmentPlans.push(created);
          createdGarments.push({ lineId: known.line_id, garmentId });
          statements.push(stmt("UPDATE order_lines SET garment_id = ? WHERE user_id = ? AND order_id = ? AND line_id = ? AND garment_id IS NULL", garmentId, ctx.userId, orderId, known.line_id));
          const w = working.find((x) => x.line_id === known.line_id);
          if (w) w.garment_id = garmentId;
          linkedExisting++;
        }
        continue;
      }
      const lineId = ctx.newId("oln");
      const replaced = line.replacesLineKey ? replacedLines.find((l) => l.line_key === line.replacesLineKey) : undefined;
      if (line.replacesLineKey && !replaced) throw new CommandError("not_found", `the replaced line '${line.replacesLineKey}' is not on the original order; nothing was written`);
      // A purchase is remade once: an original line already exchanged has passed its ownership to an earlier
      // replacement, and a second replacement would create a second record of the same purchase.
      if (replaced && replaced.state === "exchanged") throw new CommandError("precondition_failed", `the line '${line.replacesLineKey}' was already exchanged for an earlier replacement; nothing was written`, { replacesLineKey: line.replacesLineKey });
      let incomingGarmentId: string | null = null;
      const wanted = incomingByKey.get(line.lineKey);
      if (wanted && !replaced?.garment_id) {
        const created = await subPlan(ctx, "garment.create", {
          name: line.productName, category: wanted.category, roles: wanted.roles, careChannel: wanted.careChannel, colour: line.colour, size: line.size, maker: wanted.maker ?? p.merchant,
          acquisition: "incoming", quantity: line.quantity, source: { kind: "receipt", ref: `order:${orderId}` },
        });
        incomingGarmentId = String(created.result?.["garmentId"] ?? "");
        if (!incomingGarmentId) throw new CommandError("internal", "the incoming record could not be planned; nothing was written");
        garmentPlans.push(created);
        createdGarments.push({ lineId, garmentId: incomingGarmentId });
      }
      statements.push(
        stmt(
          `INSERT INTO order_lines (user_id, order_id, line_id, line_key, product_name, product_code, fabric_code, size, colour, fit_options_json, price_minor, currency, quantity, arrival_estimate, state, garment_id, replaces_order_id, replaces_line_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ordered', ?, ?, ?)`,
          ctx.userId, orderId, lineId, line.lineKey, line.productName, line.productCode, line.fabricCode, line.size, line.colour, JSON.stringify(line.fitOptions), line.priceMinor, line.currency ?? p.currency, line.quantity, line.arrivalEstimate,
          // A remake represents the same physical purchase: it takes over the original line's garment record.
          replaced?.garment_id ?? incomingGarmentId, replaced ? replacesOrderId : null, replaced?.line_id ?? null,
        ),
      );
      if (replaced) {
        statements.push(stmt("UPDATE order_lines SET state = 'exchanged', garment_id = NULL WHERE user_id = ? AND order_id = ? AND line_id = ?", ctx.userId, replacesOrderId, replaced.line_id));
        tookOverOriginal = true;
      }
      working.push({ line_id: lineId, line_key: line.lineKey, product_name: line.productName, state: "ordered", garment_id: replaced?.garment_id ?? incomingGarmentId, quantity: line.quantity, price_minor: line.priceMinor, refunded_minor: 0 });
      addedLines.push({ lineId, lineKey: line.lineKey, productName: line.productName });
    }

    const knownEvents = new Set((await all<{ dedupe_key: string }>(ctx.db, "SELECT dedupe_key FROM order_events WHERE user_id = ? AND order_id = ?", ctx.userId, orderId)).map((r) => r.dedupe_key));
    let newEvents = 0;
    const unknown: string[] = [];
    for (const event of p.events) {
      if (knownEvents.has(event.dedupeKey)) continue;
      knownEvents.add(event.dedupeKey);
      const built = eventStatements(ctx, orderId, working, event);
      statements.push(...built.statements);
      unknown.push(...built.unknownLineKeys);
      newEvents++;
    }
    if (unknown.length > 0) throw new CommandError("not_found", `an event names order lines that are not on this order: ${unknown.join(", ")}; nothing was written`, { lineKeys: unknown });

    const mergedRefs = [...new Set([...json<string[]>(existing?.source_refs_json, []), ...p.sourceRefs])];
    const refsChanged = existing !== null && mergedRefs.length !== json<string[]>(existing.source_refs_json, []).length;

    if (existing && addedLines.length === 0 && newEvents === 0 && !refsChanged && enrichedLines === 0 && updatedEstimateLines === 0 && linkedExisting === 0) {
      return {
        outcome: "noop",
        summary: `${named(p.merchant)} order ${named(p.orderNumber)} was already logged; nothing was duplicated`,
        affected: [{ kind: "order", id: orderId, version: existing.version }],
        result: { orderId, addedLineIds: [], lineIds: currentLines.map((l) => l.line_id), linesNeedingGarment: currentLines.filter((l) => !l.garment_id && l.state !== "cancelled").map((l) => l.line_id) },
        undo: NO_UNDO("nothing changed"),
      };
    }
    const version = (existing?.version ?? 0) + 1;
    if (existing) {
      statements.push(stmt("UPDATE orders SET version = version + 1, source_refs_json = ?, updated_at = ? WHERE user_id = ? AND order_id = ?", JSON.stringify(mergedRefs), ctx.now, ctx.userId, orderId));
    }
    if (tookOverOriginal && replacesOrderId) {
      statements.push(stmt("UPDATE orders SET version = version + 1, updated_at = ? WHERE user_id = ? AND order_id = ?", ctx.now, ctx.userId, replacesOrderId));
    }
    const stillNeeding = working.filter((l) => !l.garment_id && l.state !== "cancelled").map((l) => l.line_id);
    const preconditions = [
      ...(existing ? [{ label: `order ${orderId} unchanged since read`, sql: "(SELECT version FROM orders WHERE user_id = ? AND order_id = ?) = ?", params: [ctx.userId, orderId, existing.version], class: "internal" as const }] : []),
      ...(tookOverOriginal && replacesOrderId ? [{ label: `replaced order ${replacesOrderId} unchanged since read`, sql: "(SELECT version FROM orders WHERE user_id = ? AND order_id = ?) = ?", params: [ctx.userId, replacesOrderId, replacesOrderVersion], class: "internal" as const }] : []),
    ];
    const enrichNote = `${enrichedLines > 0 ? ` ${plural(enrichedLines, "line")} gained missing details.` : ""}${updatedEstimateLines > 0 ? ` ${plural(updatedEstimateLines, "line")} updated its arrival estimate.` : ""}`;
    const records = createdGarments.length > 0 ? ` ${plural(createdGarments.length, "wardrobe record")} created as ordered, not arrived.` : "";
    const garmentUndos = garmentPlans
      .map((g) => (g.undo as { data?: Record<string, unknown> } | undefined)?.data)
      .filter((d): d is Record<string, unknown> => !!d);
    const undoable = !existing && !tookOverOriginal && garmentUndos.length === garmentPlans.length;
    return mergePlans({
      outcome: existing ? "merged" : "committed",
      summary: existing
        ? `${named(p.merchant)} order ${named(p.orderNumber)} updated: ${plural(addedLines.length, "new line")}, ${plural(newEvents, "new event")}.${enrichNote}${records} Nothing has arrived until you say so`
        : `Logged ${named(p.merchant)} order ${named(p.orderNumber)} with ${plural(p.lines.length, "line")}${replacesOrderId ? ", linked to the order it replaces" : ""}.${records} Ordered, not arrived: nothing is wearable yet`,
      statements,
      preconditions,
      affected: [{ kind: "order", id: orderId, version }, ...(tookOverOriginal && replacesOrderId ? [{ kind: "order", id: replacesOrderId, version: replacesOrderVersion + 1 }] : [])],
      outbox: [{ topic: "search.index", entityKind: "order", entityId: orderId, revision: version }, ...(tookOverOriginal && replacesOrderId ? [{ topic: "search.index" as const, entityKind: "order" as const, entityId: replacesOrderId, revision: replacesOrderVersion + 1 }] : [])],
      result: { orderId, addedLineIds: addedLines.map((l) => l.lineId), lineIds: working.map((l) => l.line_id), linesNeedingGarment: stillNeeding, replacesOrderId, incomingRecords: createdGarments },
      undo: undoable ? { data: { orderId, version: 1, garments: garmentUndos } } : NO_UNDO("an order update or replacement is corrected with a further event, not removed"),
    }, garmentPlans, { partsFirst: true });
  },
  async planUndo(ctx, original, data) {
    const orderId = String(data["orderId"] ?? "");
    const recordedVersion = typeof data["version"] === "number" ? (data["version"] as number) : 1;
    const order = await loadOrder(ctx, orderId);
    if (order.version !== recordedVersion) {
      throw new CommandError("not_undoable", "the order has been updated since it was logged; take back the later change first", { orderId, version: order.version });
    }
    const usedByReturn = await first(ctx.db, "SELECT 1 AS x FROM return_cases WHERE user_id = ? AND (order_id = ? OR exchange_order_id = ?)", ctx.userId, orderId, orderId);
    if (usedByReturn) {
      throw new CommandError("not_undoable", "a return or exchange has been opened on or linked to this order; cancel that first", { orderId });
    }
    const replacedBy = await first(ctx.db, "SELECT 1 AS x FROM orders WHERE user_id = ? AND replaces_order_id = ?", ctx.userId, orderId);
    if (replacedBy) {
      throw new CommandError("not_undoable", "another order replaces this one; nothing was removed", { orderId });
    }
    const garmentUndos = Array.isArray(data["garments"]) ? (data["garments"] as Record<string, unknown>[]) : [];
    const garmentPlans: CommandPlan[] = [];
    for (const g of garmentUndos) {
      garmentPlans.push(await subUndo(ctx, "garment.create", original, g));
    }
    return mergePlans(
      {
        summary: `Removed ${named(order.merchant)} order ${named(order.order_number)} (order logging undone)`,
        statements: [
          stmt("DELETE FROM order_events WHERE user_id = ? AND order_id = ?", ctx.userId, orderId),
          stmt("DELETE FROM order_lines WHERE user_id = ? AND order_id = ?", ctx.userId, orderId),
          stmt("DELETE FROM orders WHERE user_id = ? AND order_id = ? AND version = ?", ctx.userId, orderId, recordedVersion),
        ],
        preconditions: [
          { label: `order ${orderId} unchanged since it was logged`, sql: "(SELECT version FROM orders WHERE user_id = ? AND order_id = ?) = ?", params: [ctx.userId, orderId, recordedVersion], class: "state" },
          { label: `no return or exchange opened on or linked to order ${orderId}`, sql: "NOT EXISTS (SELECT 1 FROM return_cases WHERE user_id = ? AND (order_id = ? OR exchange_order_id = ?))", params: [ctx.userId, orderId, orderId], class: "state" },
          { label: `no replacement order references order ${orderId}`, sql: "NOT EXISTS (SELECT 1 FROM orders WHERE user_id = ? AND replaces_order_id = ?)", params: [ctx.userId, orderId], class: "state" },
        ],
        affected: [{ kind: "order", id: orderId, version: recordedVersion + 1 }],
        outbox: [{ topic: "search.index", entityKind: "order", entityId: orderId, revision: recordedVersion + 1 }],
        undo: NO_UNDO("already an undo"),
      },
      garmentPlans,
    );
  },
});

export const purchaseRecordEvent = define({
  type: "purchase.record_event",
  schema: C["purchase.record_event"],
  class: "edit",
  requiredScope: "write",
  allowedAuthorizations: ["owner_tap", "owner_statement", "standing_policy", "data_import"],
  async plan(ctx, p) {
    const order = await loadOrder(ctx, p.orderId);
    const dup = await first(ctx.db, "SELECT 1 AS x FROM order_events WHERE user_id = ? AND order_id = ? AND dedupe_key = ?", ctx.userId, p.orderId, p.event.dedupeKey);
    if (dup) {
      return { outcome: "noop", summary: `That ${p.event.kind} notice for ${named(order.merchant)} order ${named(order.order_number)} was already recorded`, affected: [{ kind: "order", id: order.order_id, version: order.version }], result: { orderId: order.order_id }, undo: NO_UNDO("nothing changed") };
    }
    const lines = await loadLines(ctx, p.orderId);
    const built = eventStatements(ctx, p.orderId, lines, p.event);
    if (built.unknownLineKeys.length > 0) throw new CommandError("not_found", `this order has no line ${built.unknownLineKeys.join(", ")}; nothing was written`, { lineKeys: built.unknownLineKeys });
    const note =
      p.event.kind === "delivery" || p.event.kind === "dispatch"
        ? " It is not counted as arrived until you confirm it"
        : p.event.kind === "refund" || p.event.kind === "return" || p.event.kind === "cancellation"
          ? " Stock is unchanged by this notice"
          : "";
    return {
      summary: `Recorded ${p.event.kind} for ${named(order.merchant)} order ${named(order.order_number)} (${plural(built.lineIds.length, "line")}).${note}`,
      statements: [...built.statements, stmt("UPDATE orders SET version = version + 1, updated_at = ? WHERE user_id = ? AND order_id = ?", ctx.now, ctx.userId, p.orderId)],
      preconditions: [{ label: `order ${p.orderId} unchanged since read`, sql: "(SELECT version FROM orders WHERE user_id = ? AND order_id = ?) = ?", params: [ctx.userId, p.orderId, order.version], class: "internal" }],
      affected: [{ kind: "order", id: order.order_id, version: order.version + 1 }],
      outbox: [{ topic: "search.index", entityKind: "order", entityId: order.order_id, revision: order.version + 1 }],
      result: { orderId: order.order_id, lineIds: built.lineIds },
      undo: NO_UNDO("an order notice is a historical record"),
    };
  },
});

export const purchaseLinkLine = define({
  type: "purchase.link_line",
  schema: C["purchase.link_line"],
  class: "edit",
  requiredScope: "write",
  allowedAuthorizations: ["owner_tap", "owner_statement", "standing_policy", "data_import"],
  async plan(ctx, p) {
    const order = await loadOrder(ctx, p.orderId);
    const line = (await loadLines(ctx, p.orderId)).find((l) => l.line_id === p.lineId);
    if (!line) throw new CommandError("not_found", `no line '${p.lineId}' on that order; nothing was written`);
    const garment = (await requireGarments(ctx, [p.garmentId])).get(p.garmentId)!;
    if (line.garment_id === p.garmentId) return { outcome: "noop", summary: `${named(line.product_name)} is already linked to ${named(garment.name)}`, result: { orderId: p.orderId, lineId: p.lineId, garmentId: p.garmentId }, undo: NO_UNDO("nothing changed") };
    if (line.garment_id) throw new CommandError("conflict", `${line.product_name} is already linked to another garment record; a second record would double the ownership`, { garmentId: line.garment_id });
    return {
      summary: `Linked ${named(order.merchant)} order line "${named(line.product_name)}" to ${named(garment.name)}`,
      statements: [
        stmt("UPDATE order_lines SET garment_id = ? WHERE user_id = ? AND order_id = ? AND line_id = ? AND garment_id IS NULL", p.garmentId, ctx.userId, p.orderId, p.lineId),
        stmt("UPDATE orders SET version = version + 1, updated_at = ? WHERE user_id = ? AND order_id = ?", ctx.now, ctx.userId, p.orderId),
      ],
      preconditions: [{ label: "order line still unlinked", sql: "(SELECT garment_id FROM order_lines WHERE user_id = ? AND order_id = ? AND line_id = ?) IS NULL", params: [ctx.userId, p.orderId, p.lineId], class: "internal" }],
      affected: [{ kind: "order", id: p.orderId, version: order.version + 1 }],
      result: { orderId: p.orderId, lineId: p.lineId, garmentId: p.garmentId },
      undo: NO_UNDO("a link is corrected by merging or correcting the garment record"),
    };
  },
});

/** Records on the order that the owner's arrival observation happened; the stock fact is `garment.receive`. */
export const purchaseMarkDelivered = define({
  type: "purchase.mark_delivered",
  schema: C["purchase.mark_delivered"],
  class: "observation",
  // A confirmation held to the order and piece the owner was shown is refused when either changed, like garment.receive.
  staleVersions: "conflict",
  requiredScope: "write",
  async plan(ctx, p) {
    const order = await loadOrder(ctx, p.orderId);
    const line = (await loadLines(ctx, p.orderId)).find((l) => l.line_id === p.lineId);
    if (!line) throw new CommandError("not_found", `no line '${p.lineId}' on that order; nothing was written`);
    if (line.state === "delivered") return { outcome: "noop", summary: `${named(line.product_name)} was already marked delivered`, result: { orderId: p.orderId, lineId: p.lineId }, undo: NO_UNDO("nothing changed") };
    if (!(DELIVERABLE_LINE_STATES as readonly string[]).includes(line.state)) {
      throw new CommandError("conflict", `${line.product_name} is recorded as ${line.state}; an arrival cannot be recorded on a line that is ${line.state}. Nothing was written`, { lineId: p.lineId, state: line.state });
    }
    return {
      summary: `${named(line.product_name)} from ${named(order.merchant)} marked delivered on ${p.deliveredOn}`,
      statements: [
        stmt("UPDATE order_lines SET state = 'delivered', delivered_on = ? WHERE user_id = ? AND order_id = ? AND line_id = ? AND state = ?", p.deliveredOn, ctx.userId, p.orderId, p.lineId, line.state),
        stmt("UPDATE orders SET version = version + 1, updated_at = ? WHERE user_id = ? AND order_id = ?", ctx.now, ctx.userId, p.orderId),
      ],
      preconditions: [
        { label: `order ${p.orderId} unchanged since read`, sql: "(SELECT version FROM orders WHERE user_id = ? AND order_id = ?) = ?", params: [ctx.userId, p.orderId, order.version], class: "internal" },
        { label: "order line still in the state read", sql: "(SELECT state FROM order_lines WHERE user_id = ? AND order_id = ? AND line_id = ?) = ?", params: [ctx.userId, p.orderId, p.lineId, line.state], class: "internal" },
      ],
      affected: [{ kind: "order", id: p.orderId, version: order.version + 1 }],
      result: { orderId: p.orderId, lineId: p.lineId, deliveredOn: p.deliveredOn, garmentId: line.garment_id },
      undo: { data: { orderId: p.orderId, lineId: p.lineId, previousState: line.state, previousDeliveredOn: line.delivered_on ?? null, orderVersion: order.version + 1 } },
    };
  },
  async planUndo(ctx, _original, data) {
    // The line goes back to the state it was in before the arrival was recorded (ordered or dispatched).
    const order = await loadOrder(ctx, String(data["orderId"]));
    const line = (await loadLines(ctx, String(data["orderId"]))).find((l) => l.line_id === data["lineId"]);
    if (!line) throw new CommandError("not_undoable", "that order line is no longer on record", { lineId: data["lineId"] });
    if (line.state !== "delivered") throw new CommandError("not_undoable", "that order line is no longer marked delivered; nothing to take back", { lineId: data["lineId"], state: line.state });
    const recordedVersion = typeof data["orderVersion"] === "number" ? (data["orderVersion"] as number) : null;
    if (recordedVersion !== null && order.version !== recordedVersion) {
      throw new CommandError("not_undoable", "that order has changed since the arrival was recorded; record a new event to correct it instead", { orderId: data["orderId"], version: order.version, recordedVersion });
    }
    const previousState = String(data["previousState"] ?? "ordered");
    if (!(DELIVERABLE_LINE_STATES as readonly string[]).includes(previousState)) throw new CommandError("not_undoable", "the recorded earlier state of that line is not one an arrival can return to", { previousState });
    return {
      preconditions: [
        { label: `order ${String(data["orderId"])} unchanged since read`, sql: "(SELECT version FROM orders WHERE user_id = ? AND order_id = ?) = ?", params: [ctx.userId, data["orderId"], order.version], class: "internal" },
        { label: "order line still delivered", sql: "(SELECT state FROM order_lines WHERE user_id = ? AND order_id = ? AND line_id = ?) = 'delivered'", params: [ctx.userId, data["orderId"], data["lineId"]], class: "internal" },
      ],
      summary: `${named(line.product_name)} is no longer marked delivered`,
      statements: [
        stmt("UPDATE order_lines SET state = ?, delivered_on = ? WHERE user_id = ? AND order_id = ? AND line_id = ? AND state = 'delivered'", previousState, (data["previousDeliveredOn"] as string | null) ?? null, ctx.userId, data["orderId"], data["lineId"]),
        stmt("UPDATE orders SET version = version + 1, updated_at = ? WHERE user_id = ? AND order_id = ?", ctx.now, ctx.userId, data["orderId"]),
      ],
      affected: [{ kind: "order", id: String(data["orderId"]), version: order.version + 1 }],
      undo: NO_UNDO("this is already an undo; repeat the original action instead"),
    };
  },
});

export const purchaseHandlers = [purchaseImportOrder, purchaseRecordEvent, purchaseLinkLine, purchaseMarkDelivered];
