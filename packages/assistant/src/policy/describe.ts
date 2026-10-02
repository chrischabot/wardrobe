/**
 * The summary of a proposed change, written by trusted code.
 *
 * A proposal is what the owner confirms, so its summary must say exactly what would be written, in the
 * system's own sentence. Nothing here is model prose: the sentence comes from this file, garments and
 * records are named from the ledger by their IDs, and every free-text value that would be stored (a
 * name, a rule, a reason, a note) is shown inside quotation marks as the value it is, on one line and
 * with control characters removed, so it can never read as the system speaking.
 */
import { all, first, type Db } from "@garderobe/domain";

/** A stored free-text value as it appears inside a summary: one line, quoted, never the system's own voice. */
export function quoted(value: unknown, max = 300): string {
  const clean = String(value ?? "")
    .replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, " ")
    .replace(/[\u201C\u201D"]/g, "'")
    .replace(/\s+/g, " ")
    .trim();
  return `\u201C${clean.length > max ? `${clean.slice(0, max - 1).trimEnd()}\u2026` : clean}\u201D`;
}

const words = (value: unknown) => String(value ?? "").replace(/_/g, " ");
const list = (items: string[]) => (items.length <= 1 ? (items[0] ?? "nothing") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`);
const minor = (value: unknown, currency: unknown) => (typeof value === "number" ? `${currency ? `${String(currency)} ` : ""}${(value / 100).toFixed(2)}` : null);

async function garmentNames(db: Db, userId: string, ids: unknown[]): Promise<string[]> {
  const out: string[] = [];
  for (const id of ids.map(String)) {
    const row = await first<{ name: string }>(db, "SELECT name FROM garments WHERE user_id = ? AND garment_id = ?", userId, id);
    out.push(row ? quoted(row.name, 80) : `a piece that is not in the wardrobe (${quoted(id, 40)})`);
  }
  return out;
}

function fields(payload: Record<string, unknown>, keys: string[]): string {
  const parts = keys.filter((k) => payload[k] !== undefined && payload[k] !== null && payload[k] !== "").map((k) => `${words(k)} ${typeof payload[k] === "string" ? quoted(payload[k]) : JSON.stringify(payload[k])}`);
  return parts.join(", ");
}

type P = Record<string, any>;

/** One sentence (or a few) stating exactly what confirming would write. */
export async function describeChange(db: Db, userId: string, type: string, p: P): Promise<string> {
  const g = async (ids: unknown[]) => list(await garmentNames(db, userId, ids));
  switch (type) {
    case "wear.record":
      return `Record that you wore ${await g(p.garmentIds ?? [])} on ${p.wearingDate}.`;
    case "wear.amend":
      return `Correct what you wore on ${p.wearingDate}: remove ${await g(p.remove ?? [])}; add ${await g(p.add ?? [])}.`;
    case "care.mark_dirty":
      return `Mark as needing a wash: ${await g((p.items ?? []).map((i: P) => i.garmentId))}.`;
    case "care.washed":
      return p.allOfChannel ? `Mark every ${words(p.allOfChannel)} piece as washed and clean.` : `Mark as washed and clean: ${await g((p.items ?? []).map((i: P) => i.garmentId))}.`;
    case "feedback.record":
      return `Keep a comfort note (${words(p.kind)}) about ${await g(p.garmentIds ?? [])}: ${quoted(p.text)}.`;
    case "garment.create":
      return `Add a piece to your wardrobe as ${p.acquisition === "incoming" ? "ordered, not yet arrived" : "owned"}: ${quoted(p.name)} (${words(p.category)}${p.quantity && p.quantity !== 1 ? `, quantity ${p.quantity}` : ""})${fields(p, ["colour", "fabric", "maker", "size"]) ? `, ${fields(p, ["colour", "fabric", "maker", "size"])}` : ""}.`;
    case "assistant.report_arrival":
    case "garment.receive":
      return `Record that ${await g([p.garmentId])} has arrived and is now owned and wearable.`;
    case "garment.correct":
      return `Change the record of ${await g([p.garmentId])}: ${fields(p.changes ?? {}, ["name", "colour", "fabric", "maker", "size", "condition"]) || "no fields"}.`;
    case "garment.add_alias":
      return `Let ${await g([p.garmentId])} also answer to the name ${quoted(p.phrase)}.`;
    case "garment.move":
      return `Record that ${await g([p.garmentId])} ${p.to === "clean" ? `is back${p.from ? ` from ${words(p.from)}` : ""} and available` : `went to ${words(p.to)}`}${p.note ? ` (note ${quoted(p.note)})` : ""}.`;
    case "garment.retire":
      return `Record that ${await g([p.garmentId])} has left your wardrobe for good (${words(p.disposition)})${p.note ? `, note ${quoted(p.note)}` : ""}. It will no longer be suggested.`;
    case "restriction.add":
      return `Add a restriction (${words(p.kind)}) on ${await g(p.scope?.garmentIds ?? [])} with the reason ${quoted(p.reason)}. They are not suggested until you say it has ended.`;
    case "assistant.lift_restriction": {
      const r = await first<{ kind: string; reason: string; scope_json: string }>(db, "SELECT kind, reason, scope_json FROM restrictions WHERE user_id = ? AND restriction_id = ?", userId, p.restrictionId);
      if (!r) return `Lift a restriction that is not on record (${quoted(p.restrictionId, 40)}).`;
      const scoped = ((JSON.parse(r.scope_json || "{}") as { garmentIds?: string[] }).garmentIds ?? []) as string[];
      const released = scoped.length > 0 ? ` The pieces it holds back become available again: ${await g(scoped.slice(0, 12))}${scoped.length > 12 ? ` and ${scoped.length - 12} more` : ""}.` : " Every piece it holds back becomes available again.";
      return `LIFT the restriction (${words(r.kind)}) whose reason is ${quoted(r.reason)}, and note in your profile that it has ended.${released} Confirm only if its condition really has ended.`;
    }
    case "style.add_direction":
      return `Add a standing rule for all future suggestions: ${quoted(p.text)}${p.scope ? `, applying to ${quoted(p.scope)}` : ""}.`;
    case "style.set_brief":
      return `Set a brief for ${p.localDate} only: ${quoted(p.text)}.`;
    case "style.add_amendment":
      return `Amend your profile (${words(p.kind)}) with the dated statement ${quoted(p.text)}.`;
    case "measurement.record":
      return `Record a ${words(p.subject ?? "body")} measurement: ${quoted(p.key, 60)} = ${p.value} ${p.unit}, measured on ${p.measuredOn}.`;
    case "purchase.import_order": {
      const lines = (p.lines ?? []).map((l: P) => `${quoted(l.productName, 80)}${l.size ? ` size ${quoted(l.size, 20)}` : ""}${l.quantity && l.quantity !== 1 ? ` x${l.quantity}` : ""}${minor(l.priceMinor, l.currency ?? p.currency) ? ` at ${minor(l.priceMinor, l.currency ?? p.currency)}` : ""}`);
      const incoming = (p.incoming ?? []).length;
      return `Log an order from ${quoted(p.merchant, 80)}, number ${quoted(p.orderNumber, 60)}${p.orderedOn ? `, ordered on ${p.orderedOn}` : ""}: ${list(lines)}.${incoming > 0 ? ` ${incoming} wardrobe record${incoming === 1 ? " is" : "s are"} created as ordered, not arrived.` : ""} Nothing becomes wearable until you say it arrived.`;
    }
    case "purchase.record_event": {
      const o = await first<{ merchant: string; order_number: string }>(db, "SELECT merchant, order_number FROM orders WHERE user_id = ? AND order_id = ?", userId, p.orderId);
      return `Attach a ${words(p.event?.kind)} notice dated ${String(p.event?.occurredAt ?? "").slice(0, 10)} to the order ${o ? `${quoted(o.merchant, 80)} ${quoted(o.order_number, 60)}` : quoted(p.orderId, 40)}${minor(p.event?.amountMinor, null) ? `, amount ${minor(p.event?.amountMinor, null)}` : ""}. It changes no stock.`;
    }
    case "return.open_case":
      return `Open ${p.kind === "exchange" ? "an exchange" : "a return"}${p.garmentId ? ` for ${await g([p.garmentId])}` : ""}${p.terms ? `, with a ${p.terms.windowDays}-day window to ${words(p.terms.concerns)} counted from ${words(p.terms.triggerEvent)} (source ${quoted(p.terms.sourceRef, 120)})` : ", deadline not yet known"}${p.triggerDate ? `, counted from ${p.triggerDate}` : ""}${minor(p.refundExpectedMinor, p.currency) ? `, refund expected ${minor(p.refundExpectedMinor, p.currency)}` : ""}${p.reason ? `, reason ${quoted(p.reason)}` : ""}${p.nextAction ? `, next step ${quoted(p.nextAction)}` : ""}. Nothing leaves your wardrobe by this.`;
    case "return.update_case": {
      const c = await first<{ kind: string; state: string }>(db, "SELECT kind, state FROM return_cases WHERE user_id = ? AND case_id = ?", userId, p.caseId);
      const changes: string[] = [];
      if (p.state) changes.push(`state becomes ${words(p.state)}`);
      if (p.terms) changes.push(`window becomes ${p.terms.windowDays} days to ${words(p.terms.concerns)} from ${words(p.terms.triggerEvent)} (source ${quoted(p.terms.sourceRef, 120)})`);
      if (p.triggerDate) changes.push(`the window counts from ${p.triggerDate}`);
      if (p.retailerReceivedOn) changes.push(`retailer received it on ${p.retailerReceivedOn}`);
      if (typeof p.refundReceivedMinor === "number") changes.push(`refund received ${minor(p.refundReceivedMinor, p.currency)}`);
      if (p.labelRef) changes.push(`label ${quoted(p.labelRef, 80)}`);
      if (p.shipmentRef) changes.push(`shipment ${quoted(p.shipmentRef, 80)}`);
      if (p.nextAction) changes.push(`next step ${quoted(p.nextAction)}`);
      return `Update the ${c ? `${c.kind} (currently ${words(c.state)})` : `return ${quoted(p.caseId, 40)}`}: ${changes.join("; ") || "no change"}.`;
    }
    case "return.link_exchange":
      return `Link the replacement order line to the exchange ${quoted(p.caseId, 40)}, so the piece is not counted twice.`;
    case "lifecycle.open_project": {
      const hold = p.kind === "sale" || p.kind === "consignment" ? " The pieces stay owned but are held back from suggestions while for sale." : "";
      return `Open a ${words(p.kind)} project ${quoted(p.title, 120)} for ${await g((p.items ?? []).map((i: P) => i.garmentId))}${p.destination ? `, destination ${quoted(p.destination, 120)}` : ""}${p.nextAction ? `, next step ${quoted(p.nextAction)}` : ""}.${hold}`;
    }
    case "lifecycle.record_event": {
      const project = await first<{ title: string }>(db, "SELECT title FROM lifecycle_projects WHERE user_id = ? AND project_id = ?", userId, p.projectId);
      const moves: Record<string, string> = { sent_to_tailor: "are recorded as gone to the tailor", returned_from_tailor: "are recorded as back and available", stored: "are recorded as in storage", retrieved: "are recorded as back and available", pickup_completed: "LEAVE your wardrobe for good (sold)", discarded: "LEAVE your wardrobe for good (discarded)" };
      let pieces = (p.garmentIds ?? []) as string[];
      if (p.moveStock && pieces.length === 0) pieces = (await all<{ garment_id: string }>(db, "SELECT garment_id FROM lifecycle_project_items WHERE user_id = ? AND project_id = ?", userId, p.projectId)).map((r) => r.garment_id);
      const stock = p.moveStock && moves[p.kind] ? ` ${await g(pieces)} ${moves[p.kind]}.` : "";
      return `Record ${quoted(words(p.kind), 40)} on the project ${project ? quoted(project.title, 120) : quoted(p.projectId, 40)}${minor(p.proceedsMinor, p.currency) ? `, proceeds ${minor(p.proceedsMinor, p.currency)}` : ""}${p.nextAction ? `, next step ${quoted(p.nextAction)}` : ""}.${stock}`;
    }
    case "lifecycle.authorize_action": {
      const project = await first<{ title: string }>(db, "SELECT title FROM lifecycle_projects WHERE user_id = ? AND project_id = ?", userId, p.projectId);
      return `AUTHORIZE the assistant to ${words(p.action)} for the project ${project ? quoted(project.title, 120) : quoted(p.projectId, 40)}, within the scope ${quoted(p.scope)}. It will not ask again for this project.`;
    }
    case "job.create":
      if (p.kind === "email_investigation") return `Search your mailbox for purchases from ${p.params?.from} to ${p.params?.to}${(p.params?.merchants ?? []).length > 0 ? ` at ${list((p.params.merchants as string[]).map((m) => quoted(m, 60)))}` : ""}${p.params?.importAuthorizedBy ? " and LOG the orders it finds (as ordered, not arrived)" : "; found orders are kept as a draft and nothing is logged"}.`;
      return `Start background work (${words(p.kind)}): ${quoted(p.title, 180)}.`;
    case "reminder.set":
      return `${p.reminderId ? "Change the reminder to" : "Set a reminder"} ${quoted(p.title, 200)} for ${p.dueAt}${p.note ? `, note ${quoted(p.note)}` : ""}${p.url ? `, link ${quoted(p.url, 200)}` : ""}.`;
    case "reminder.cancel": {
      const r = await first<{ title: string }>(db, "SELECT title FROM reminders WHERE user_id = ? AND reminder_id = ?", userId, p.reminderId);
      return `Remove the reminder ${r ? quoted(r.title, 200) : quoted(p.reminderId, 40)}.`;
    }
    case "settings.update":
      return `Change settings: ${quoted(JSON.stringify(p.patch ?? {}), 300)}.`;
    case "memory.record_conclusion":
      return `Remember as ${p.status === "active" ? "settled" : "a candidate"} (${words(p.kind)}), attributed to ${p.speaker === "owner" ? "you" : "the assistant"}: ${quoted(p.text)}.`;
    case "memory.set_status": {
      const m = await first<{ text: string }>(db, "SELECT text FROM memory_conclusions WHERE user_id = ? AND conclusion_id = ?", userId, p.conclusionId);
      return `${p.status === "retired" ? "Retire" : "Confirm"} the remembered conclusion ${m ? quoted(m.text) : quoted(p.conclusionId, 40)}${p.correctedText ? `, corrected to ${quoted(p.correctedText)}` : ""}.`;
    }
    case "conversation.forget_source":
      return `FORGET ${p.sourceIds?.length ?? 0} ${words(p.sourceKind)}${(p.sourceIds?.length ?? 0) === 1 ? "" : "s"} for good: the text is removed from the conversation, recall, memory and the records of what was done with it. This cannot be undone. Rules, profile amendments and wardrobe records it led to are kept and listed on the receipt.`;
    case "command.undo": {
      const c = await first<{ type: string; receipt_json: string }>(db, "SELECT type, receipt_json FROM commands WHERE user_id = ? AND command_id = ?", userId, p.commandId);
      let was = "";
      try {
        was = c ? String((JSON.parse(c.receipt_json) as { summary?: string }).summary ?? "") : "";
      } catch {
        was = "";
      }
      return c ? `Undo an earlier change (${quoted(c.type, 60)}) whose receipt read ${quoted(was)}.` : `Undo a change that is not on record (${quoted(p.commandId, 40)}).`;
    }
    default: {
      const body = Object.entries(p)
        .filter(([, v]) => v !== null && v !== undefined)
        .map(([k, v]) => `${words(k)} ${quoted(typeof v === "string" ? v : JSON.stringify(v), 160)}`)
        .join(", ");
      return `Carry out ${quoted(type, 60)} with ${body || "no details"}.`;
    }
  }
}

/**
 * The versions a proposal was built against, as the command's expected versions: a proposal about a
 * record that has changed since is refused as stale when the owner confirms it.
 */
export async function expectedVersionsFor(db: Db, userId: string, type: string, p: P): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  const garment = async (id: unknown) => {
    if (typeof id !== "string") return;
    const row = await first<{ version: number }>(db, "SELECT version FROM garments WHERE user_id = ? AND garment_id = ?", userId, id);
    if (row) out[`garment:${id}`] = row.version;
  };
  const versioned = async (kind: string, table: string, column: string, id: unknown) => {
    if (typeof id !== "string") return;
    const row = await first<{ version: number }>(db, `SELECT version FROM ${table} WHERE user_id = ? AND ${column} = ?`, userId, id);
    if (row) out[`${kind}:${id}`] = row.version;
  };
  switch (type) {
    // A correction overwrites fields: it must not land on a record that changed since it was proposed.
    // Retiring, moving or receiving a piece is checked by the command itself against the piece's state.
    case "garment.correct":
      await garment(p.garmentId);
      break;
    case "return.update_case":
    case "return.link_exchange":
      await versioned("return_case", "return_cases", "case_id", p.caseId);
      break;
    case "lifecycle.record_event":
    case "lifecycle.authorize_action":
      await versioned("lifecycle_project", "lifecycle_projects", "project_id", p.projectId);
      break;
    case "reminder.cancel":
      await versioned("reminder", "reminders", "reminder_id", p.reminderId);
      break;
    case "memory.set_status":
      await versioned("memory_conclusion", "memory_conclusions", "conclusion_id", p.conclusionId);
      break;
    default:
      break;
  }
  return out;
}
