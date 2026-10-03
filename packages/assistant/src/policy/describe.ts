/**
 * The summary of a proposed change, written by trusted code.
 *
 * A proposal is what the owner confirms, so its summary must say exactly what would be written, in the
 * system's own sentence. Nothing here is model prose: the sentence comes from this file, garments and
 * records are named from the ledger by their IDs, and every free-text value that would be stored (a
 * name, a rule, a reason, a note) is shown inside quotation marks as the value it is, on one line and
 * with control characters removed, so it can never read as the system speaking.
 */
import { CommandError, all, first, type Db } from "@garderobe/domain";
import { RECORD_CHANGING_TYPES } from "./classes.ts";

/** The longest single stored value a summary shows. A longer one is not clipped: the request is refused. */
export const MAX_SHOWN_VALUE = 2000;
/** The longest summary the owner is asked to read and confirm. */
export const MAX_SUMMARY = 8000;

/** Control, format (zero-width, bidirectional), private-use and unpaired-surrogate characters, and line and paragraph separators. */
const INVISIBLE = /[\p{Cc}\p{Cf}\p{Co}\p{Cs}\p{Zl}\p{Zp}]+/gu;
/** Every character that could read as a quotation mark closing the value: they are all shown as an apostrophe. */
const QUOTE_LIKE = /["\u00AB\u00BB\u02BA\u02DD\u02EE\u05F4\u201C-\u201F\u2033\u2034\u2036\u2037\u2039\u203A\u275D\u275E\u276E\u276F\u2E42\u301D-\u301F\uFF02]/g;

function tooLong(what: string): CommandError {
  return new CommandError("invalid_command", `${what} is too long to be shown to the owner in full, and a request is never confirmed on a shortened summary. Nothing was recorded; ask for it in a shorter form`, { reason: "summary_too_long" });
}

/**
 * A stored free-text value as it appears inside a summary: IN FULL, on one line, inside quotation marks,
 * never the system's own voice. Invisible and direction-changing characters are removed and anything that
 * looks like a closing quotation mark is shown as an apostrophe, so the value cannot appear to end early.
 * A value too long to show in full is never shortened: describing it fails and nothing is proposed.
 */
export function quoted(value: unknown): string {
  const clean = String(value ?? "")
    .replace(INVISIBLE, " ")
    .replace(QUOTE_LIKE, "'")
    .replace(/\s+/gu, " ")
    .trim();
  if (clean.length > MAX_SHOWN_VALUE) throw tooLong("A value in this request");
  return `\u201C${clean}\u201D`;
}

const words = (value: unknown) => String(value ?? "").replace(/_/g, " ").replace(INVISIBLE, " ").replace(QUOTE_LIKE, "'");
const list = (items: string[]) => (items.length <= 1 ? (items[0] ?? "nothing") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`);
const minor = (value: unknown, currency: unknown) => (typeof value === "number" ? `${currency ? `${words(currency)} ` : ""}${(value / 100).toFixed(2)}` : null);

async function garmentNames(db: Db, userId: string, ids: unknown[]): Promise<string[]> {
  const out: string[] = [];
  for (const id of ids.map(String)) {
    const row = await first<{ name: string }>(db, "SELECT name FROM garments WHERE user_id = ? AND garment_id = ?", userId, id);
    out.push(row ? quoted(row.name) : `a piece that is not in the wardrobe (${quoted(id)})`);
  }
  return out;
}

function fields(payload: Record<string, unknown>, keys: string[]): string {
  const parts = keys.filter((k) => payload[k] !== undefined && payload[k] !== null && payload[k] !== "").map((k) => `${words(k)} ${typeof payload[k] === "string" ? quoted(payload[k]) : quoted(JSON.stringify(payload[k]))}`);
  return parts.join(", ");
}

/** Every leaf of a payload as `[path, value]`, with `*` for a list position; empty values are not leaves. */
function leaves(value: unknown, path: string[] = [], out: { path: string[]; value: string | number | boolean }[] = []): { path: string[]; value: string | number | boolean }[] {
  if (value === null || value === undefined || value === "") return out;
  if (Array.isArray(value)) value.forEach((v, n) => leaves(v, [...path, String(n)], out));
  else if (typeof value === "object") for (const [k, v] of Object.entries(value as Record<string, unknown>)) leaves(v, [...path, k], out);
  else out.push({ path, value: value as string | number | boolean });
  return out;
}

/**
 * The payload fields each sentence below states itself, in full (a list position is `*`). EVERY other
 * field of the payload is listed after the sentence, by name and in full, whatever the command type: the
 * owner confirms the whole change, never a part of it. A type that is not listed states nothing itself.
 */
const STATED: Record<string, string[]> = {
  "wear.record": ["wearingDate", "garmentIds.*"],
  "wear.amend": ["wearingDate", "remove.*", "add.*"],
  "care.mark_dirty": ["items.*.garmentId"],
  "care.washed": ["allOfChannel", "items.*.garmentId"],
  "feedback.record": ["kind", "garmentIds.*", "text"],
  "garment.create": ["name", "category", "acquisition", "quantity", "colour", "fabric", "maker", "size", "roles.*", "careChannel"],
  "assistant.report_arrival": ["garmentId"],
  "garment.receive": ["garmentId"],
  "garment.correct": ["garmentId", "changes.name", "changes.colour", "changes.fabric", "changes.maker", "changes.size", "changes.condition"],
  "garment.add_alias": ["garmentId", "phrase"],
  "garment.move": ["garmentId", "to", "note"],
  "garment.retire": ["garmentId", "disposition", "note"],
  "restriction.add": ["kind", "scope.garmentIds.*", "reason"],
  "assistant.lift_restriction": ["restrictionId"],
  "style.add_direction": ["text", "scope"],
  "style.set_brief": ["localDate", "text"],
  "style.add_amendment": ["kind", "text"],
  "measurement.record": ["subject", "key", "value", "unit", "measuredOn"],
  "purchase.import_order": ["merchant", "orderNumber", "orderedOn"],
  "purchase.record_event": ["orderId", "event.kind", "event.occurredAt"],
  "return.open_case": ["kind", "garmentId", "terms.windowDays", "terms.concerns", "terms.triggerEvent", "terms.sourceRef", "triggerDate", "reason", "nextAction"],
  "return.update_case": ["caseId", "state", "terms.windowDays", "terms.concerns", "terms.triggerEvent", "terms.sourceRef", "triggerDate", "retailerReceivedOn", "labelRef", "shipmentRef", "nextAction"],
  "return.link_exchange": ["caseId"],
  "lifecycle.open_project": ["kind", "title", "items.*.garmentId", "destination", "nextAction"],
  "lifecycle.record_event": ["projectId", "kind", "nextAction"],
  "lifecycle.authorize_action": ["projectId", "action", "scope"],
  "job.create": ["kind", "title", "params.from", "params.to", "params.merchants.*"],
  "reminder.set": ["reminderId", "title", "dueAt", "note", "url"],
  "reminder.cancel": ["reminderId"],
  "memory.record_conclusion": ["status", "kind", "speaker", "text"],
  "memory.set_status": ["conclusionId", "status", "correctedText"],
  "conversation.forget_source": ["sourceKind"],
  "command.undo": ["commandId"],
};

/** A machine code word (`mid_layer`, `owner_statement`): shown with spaces, but only in a field that holds codes. */
const CODE_WORD = /^[a-z]+(?:_[a-z]+)+$/;
/**
 * Fields whose values are codes from a fixed vocabulary. Only these are reworded (underscores as spaces);
 * a free-text field that happens to look like a code is shown exactly as it would be stored.
 */
const CODE_FIELDS = new Set(["kind", "status", "state", "speaker", "disposition", "acquisition", "careChannel", "allOfChannel", "category", "role", "roles", "to", "from", "action", "concerns", "triggerEvent", "sourceKind", "subject", "basis", "channel", "importAuthorizedBy", "condition", "location"]);
/** Fields that hold a reference to a record or a message. Only these are looked up and named. */
const REFERENCE_FIELD = /(?:Ids?|Refs?)$|^(?:ref|remove|add)$/;

/** Records a payload can refer to by identifier, and how each is named to the owner. */
const RECORDS: Record<string, { sql: string; say: (row: Record<string, unknown>) => string }> = {
  gmt: { sql: "SELECT name FROM garments WHERE user_id = ? AND garment_id = ?", say: (r) => `the piece ${quoted(r["name"])}` },
  prd: { sql: "SELECT name FROM products WHERE user_id = ? AND product_id = ?", say: (r) => `the shopping candidate ${quoted(r["name"])}` },
  ord: { sql: "SELECT merchant, order_number FROM orders WHERE user_id = ? AND order_id = ?", say: (r) => `the order ${quoted(r["merchant"])} ${quoted(r["order_number"])}` },
  lcp: { sql: "SELECT title FROM lifecycle_projects WHERE user_id = ? AND project_id = ?", say: (r) => `the project ${quoted(r["title"])}` },
  mem: { sql: "SELECT text FROM memory_conclusions WHERE user_id = ? AND conclusion_id = ?", say: (r) => `the remembered conclusion ${quoted(r["text"])}` },
  rem: { sql: "SELECT title FROM reminders WHERE user_id = ? AND reminder_id = ?", say: (r) => `the reminder ${quoted(r["title"])}` },
  rst: { sql: "SELECT kind, reason FROM restrictions WHERE user_id = ? AND restriction_id = ?", say: (r) => `the restriction (${words(r["kind"])}) whose reason is ${quoted(r["reason"])}` },
  trp: { sql: "SELECT name, departs_on, returns_on FROM trips WHERE user_id = ? AND trip_id = ?", say: (r) => `the trip ${quoted(r["name"])} (${r["departs_on"]} to ${r["returns_on"]})` },
  brd: { sql: "SELECT local_date FROM boards WHERE user_id = ? AND board_id = ?", say: (r) => `the outfit board for ${r["local_date"]}` },
  opt: { sql: "SELECT o.position, o.revision, b.local_date FROM board_options o JOIN boards b ON b.user_id = o.user_id AND b.board_id = o.board_id WHERE o.user_id = ? AND o.option_id = ? ORDER BY o.revision DESC LIMIT 1", say: (r) => `outfit option ${Number(r["position"]) + 1} on the board for ${r["local_date"]} (revision ${r["revision"]})` },
  lb: { sql: "SELECT channel, picked_up_at FROM laundry_batches WHERE user_id = ? AND batch_id = ?", say: (r) => `the ${r["channel"] === "handwash" ? "hand-wash" : "laundry service"} bag picked up on ${String(r["picked_up_at"]).slice(0, 10)}` },
  cmd: { sql: "SELECT type, receipt_json FROM commands WHERE user_id = ? AND command_id = ?", say: (r) => `the earlier change whose receipt read ${quoted(receiptSummary(r["receipt_json"]))}` },
  job: { sql: "SELECT title FROM assistant_jobs WHERE user_id = ? AND job_id = ?", say: (r) => `the background work ${quoted(r["title"])}` },
  ret: { sql: "SELECT c.kind, g.name FROM return_cases c LEFT JOIN garments g ON g.user_id = c.user_id AND g.garment_id = c.garment_id WHERE c.user_id = ? AND c.case_id = ?", say: (r) => `the ${words(r["kind"])}${r["name"] ? ` of ${quoted(r["name"])}` : ""}` },
};

function receiptSummary(receiptJson: unknown): string {
  try {
    return String((JSON.parse(String(receiptJson)) as { summary?: string }).summary ?? "");
  } catch {
    return "";
  }
}

/** When a message was sent, to the second: two messages of the same minute do not read alike. */
const when = (instant: unknown) => `${String(instant).slice(0, 10)} at ${String(instant).slice(11, 19)} UTC`;

/**
 * A value that refers to a record, in words: a message of the conversation by when it was sent, a record
 * by its name. Null when the value is not such a reference or the record is not on file (it is then shown
 * as the value it is, in full).
 */
async function referenceInWords(db: Db, userId: string, value: string): Promise<string | null> {
  if (value.startsWith("message:") || value.startsWith("msg_")) {
    const turn = await first<{ created_at: string }>(db, "SELECT created_at FROM assistant_turns WHERE user_id = ? AND user_message_id = ?", userId, value.replace(/^message:/, ""));
    return turn ? `your message of ${when(turn.created_at)}` : null;
  }
  const cut = value.indexOf("_");
  const record = cut > 0 ? RECORDS[value.slice(0, cut)] : undefined;
  if (!record) return null;
  const row = await first<Record<string, unknown>>(db, record.sql, userId, value);
  return row ? record.say(row) : null;
}

/** The shape of a record identifier: a short prefix and an opaque tail without spaces. It cannot carry prose. */
const IDENTIFIER = /^[a-z]{2,5}_[A-Za-z0-9_]{6,}$/;

/**
 * One stored value as the owner reads it. What is done depends on the FIELD, never on what the value
 * happens to look like: a reference field is named by the record it refers to; a code field is shown in
 * words; every other value is quoted exactly as it would be stored. A reference that names no record on
 * file is never hidden: it is shown in full and said to match nothing (the one exception, an identifier
 * trusted code minted in this turn for the record being created, is handled by the caller).
 */
async function shown(db: Db, userId: string, value: string | number | boolean, field = ""): Promise<string> {
  if (typeof value !== "string") return String(value);
  if (REFERENCE_FIELD.test(field)) {
    const reference = await referenceInWords(db, userId, value);
    if (reference) return reference;
    if (IDENTIFIER.test(value)) return `an identifier that matches no record on file (${quoted(value)})`;
    return quoted(value);
  }
  return quoted(CODE_FIELDS.has(field) && CODE_WORD.test(value) ? words(value) : value);
}

/** What kind of source trusted code recorded for the change, in words. */
const SOURCE_KINDS: Record<string, string> = {
  owner_statement: "your own statement",
  photograph: "a photograph you sent, as the assistant read it (you wrote no words of your own)",
  model_inference: "the assistant's own reading of what was attached or found (you wrote no words of your own)",
};

/** The fields of the payload the sentence did not state, each by name and in full, in words. */
async function unstated(db: Db, userId: string, type: string, payload: Record<string, unknown>, minted: ReadonlySet<string>): Promise<string> {
  const stated = new Set(STATED[type] ?? []);
  let rest = leaves(payload).filter((leaf) => !stated.has(leaf.path.map((s) => (/^\d+$/.test(s) ? "*" : s)).join(".")));
  // The provenance trusted code attaches to a change reads as one phrase rather than two fields.
  let provenance = "";
  const source = payload["source"] as { kind?: unknown; ref?: unknown } | null | undefined;
  if (source && typeof source === "object" && typeof source.kind === "string" && typeof source.ref === "string" && Object.keys(source).every((k) => k === "kind" || k === "ref")) {
    provenance = ` Its source is recorded as ${SOURCE_KINDS[source.kind] ?? words(source.kind)}, ${(await referenceInWords(db, userId, source.ref)) ?? quoted(source.ref)}.`;
    rest = rest.filter((leaf) => leaf.path[0] !== "source");
  }
  if (rest.length === 0) return provenance;
  // A field holding a record's identifier is named by the record ("garment id" reads "garment").
  const label = (path: string[]) => path.map((s) => (/^\d+$/.test(s) ? `${Number(s) + 1}` : words(s.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase()))).join(" ").replace(/ ids?\b/g, "").replace(/ refs?\b/g, " reference");
  const parts: string[] = [];
  for (const leaf of rest) {
    const field = leaf.path.filter((s) => !/^\d+$/.test(s)).at(-1) ?? "";
    // The identifier trusted code made up in this turn for the record this very request creates names
    // nothing the owner knows yet, and no model chose it: it is said to be new rather than printed.
    if (typeof leaf.value === "string" && minted.has(leaf.value) && REFERENCE_FIELD.test(field)) parts.push(`a new ${label(leaf.path)} record is created`);
    else parts.push(`${label(leaf.path)} ${await shown(db, userId, leaf.value, field)}`);
  }
  return ` ${STATED[type] ? "Also written with it" : "Written exactly"}: ${parts.join("; ")}.${provenance}`;
}

type P = Record<string, any>;

/** Project events whose `moveStock` moves or retires the pieces (see STOCK_FOR_EVENT in commands/lifecycle.ts). */
const STOCK_MOVING_EVENTS = new Set(["sent_to_tailor", "returned_from_tailor", "stored", "retrieved", "pickup_completed", "discarded"]);

/**
 * What confirming would write, in full: the system's sentence for this kind of change followed by every
 * field of the payload the sentence does not state itself. Nothing is shortened. When the result would be
 * too long to read, or holds a value too long to show, this throws `invalid_command` and the caller
 * proposes nothing.
 */
export async function describeChange(db: Db, userId: string, type: string, p: P, opts: { minted?: readonly string[] } = {}): Promise<string> {
  const summary = `${await sentenceFor(db, userId, type, p)}${await unstated(db, userId, type, p, new Set(opts.minted ?? []))}`;
  if (summary.length > MAX_SUMMARY) throw tooLong("This request");
  return summary;
}

async function sentenceFor(db: Db, userId: string, type: string, p: P): Promise<string> {
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
    case "garment.create": {
      const care: Record<string, string> = { service: "goes to the laundry service", handwash: "is washed by hand", none: "is not washed" };
      // A role is a code from a fixed vocabulary; anything of another shape is shown as the value it is.
      const roles = ((p.roles ?? []) as unknown[]).map((r) => (/^[a-z]+(?:_[a-z]+)*$/.test(String(r)) ? words(r) : quoted(r)));
      const facts = fields(p, ["colour", "fabric", "maker", "size"]);
      return `Add a piece to your wardrobe as ${p.acquisition === "incoming" ? "ordered, not yet arrived" : "owned"}: ${quoted(p.name)} (${words(p.category)}${p.quantity && p.quantity !== 1 ? `, quantity ${p.quantity}` : ""})${facts ? `, ${facts}` : ""}. It ${roles.length > 0 ? `is worn as ${list(roles)} and ` : ""}${care[String(p.careChannel)] ?? `has the care ${quoted(words(p.careChannel))}`}.`;
    }
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
      if (!r) return `Lift a restriction that is not on record (${quoted(p.restrictionId)}).`;
      const scoped = ((JSON.parse(r.scope_json || "{}") as { garmentIds?: string[] }).garmentIds ?? []) as string[];
      const released = scoped.length > 0 ? ` The pieces it holds back become available again: ${await g(scoped)}.` : " Every piece it holds back becomes available again.";
      return `LIFT the restriction (${words(r.kind)}) whose reason is ${quoted(r.reason)}, and note in your profile that it has ended.${released} Confirm only if its condition really has ended.`;
    }
    case "style.add_direction":
      return `Add a standing rule for all future suggestions: ${quoted(p.text)}${p.scope ? `, applying to ${quoted(p.scope)}` : ""}.`;
    case "style.set_brief":
      return `Set a brief for ${p.localDate} only: ${quoted(p.text)}.`;
    case "style.add_amendment":
      return `Amend your profile (${words(p.kind)}) with the dated statement ${quoted(p.text)}.`;
    case "measurement.record":
      return `Record a ${words(p.subject ?? "body")} measurement: ${quoted(p.key)} = ${p.value} ${p.unit}, measured on ${p.measuredOn}.`;
    case "purchase.import_order": {
      const lines = (p.lines ?? []).map((l: P) => `${quoted(l.productName)}${l.size ? ` size ${quoted(l.size)}` : ""}${l.quantity && l.quantity !== 1 ? ` x${l.quantity}` : ""}${minor(l.priceMinor, l.currency ?? p.currency) ? ` at ${minor(l.priceMinor, l.currency ?? p.currency)}` : ""}`);
      const incoming = (p.incoming ?? []).length;
      return `Log an order from ${quoted(p.merchant)}, number ${quoted(p.orderNumber)}${p.orderedOn ? `, ordered on ${p.orderedOn}` : ""}: ${list(lines)}.${incoming > 0 ? ` ${incoming} wardrobe record${incoming === 1 ? " is" : "s are"} created as ordered, not arrived.` : ""} Nothing becomes wearable until you say it arrived.`;
    }
    case "purchase.record_event": {
      const o = await first<{ merchant: string; order_number: string }>(db, "SELECT merchant, order_number FROM orders WHERE user_id = ? AND order_id = ?", userId, p.orderId);
      return `Attach a ${words(p.event?.kind)} notice dated ${quoted(p.event?.occurredAt ?? "")} to the order ${o ? `${quoted(o.merchant)} ${quoted(o.order_number)}` : quoted(p.orderId)}${minor(p.event?.amountMinor, null) ? `, amount ${minor(p.event?.amountMinor, null)}` : ""}. It changes no stock.`;
    }
    case "return.open_case":
      return `Open ${p.kind === "exchange" ? "an exchange" : "a return"}${p.garmentId ? ` for ${await g([p.garmentId])}` : ""}${p.terms ? `, with a ${p.terms.windowDays}-day window to ${words(p.terms.concerns)} counted from ${words(p.terms.triggerEvent)} (source ${quoted(p.terms.sourceRef)})` : ", deadline not yet known"}${p.triggerDate ? `, counted from ${p.triggerDate}` : ""}${minor(p.refundExpectedMinor, p.currency) ? `, refund expected ${minor(p.refundExpectedMinor, p.currency)}` : ""}${p.reason ? `, reason ${quoted(p.reason)}` : ""}${p.nextAction ? `, next step ${quoted(p.nextAction)}` : ""}. Nothing leaves your wardrobe by this.`;
    case "return.update_case": {
      const c = await first<{ kind: string; state: string }>(db, "SELECT kind, state FROM return_cases WHERE user_id = ? AND case_id = ?", userId, p.caseId);
      const changes: string[] = [];
      if (p.state) changes.push(`state becomes ${words(p.state)}`);
      if (p.terms) changes.push(`window becomes ${p.terms.windowDays} days to ${words(p.terms.concerns)} from ${words(p.terms.triggerEvent)} (source ${quoted(p.terms.sourceRef)})`);
      if (p.triggerDate) changes.push(`the window counts from ${p.triggerDate}`);
      if (p.retailerReceivedOn) changes.push(`retailer received it on ${p.retailerReceivedOn}`);
      if (typeof p.refundReceivedMinor === "number") changes.push(`refund received ${minor(p.refundReceivedMinor, p.currency)}`);
      if (p.labelRef) changes.push(`label ${quoted(p.labelRef)}`);
      if (p.shipmentRef) changes.push(`shipment ${quoted(p.shipmentRef)}`);
      if (p.nextAction) changes.push(`next step ${quoted(p.nextAction)}`);
      return `Update the ${c ? `${c.kind} (currently ${words(c.state)})` : `return ${quoted(p.caseId)}`}: ${changes.join("; ") || "no change"}.`;
    }
    case "return.link_exchange":
      return `Link the replacement order line to ${(await referenceInWords(db, userId, String(p.caseId))) ?? `the exchange ${quoted(p.caseId)}`}, so the piece is not counted twice.`;
    case "lifecycle.open_project": {
      const hold = p.kind === "sale" || p.kind === "consignment" ? " The pieces stay owned but are held back from suggestions while for sale." : "";
      return `Open a ${words(p.kind)} project ${quoted(p.title)} for ${await g((p.items ?? []).map((i: P) => i.garmentId))}${p.destination ? `, destination ${quoted(p.destination)}` : ""}${p.nextAction ? `, next step ${quoted(p.nextAction)}` : ""}.${hold}`;
    }
    case "lifecycle.record_event": {
      const project = await first<{ title: string }>(db, "SELECT title FROM lifecycle_projects WHERE user_id = ? AND project_id = ?", userId, p.projectId);
      const moves: Record<string, string> = { sent_to_tailor: "are recorded as gone to the tailor", returned_from_tailor: "are recorded as back and available", stored: "are recorded as in storage", retrieved: "are recorded as back and available", pickup_completed: "LEAVE your wardrobe for good (sold)", discarded: "LEAVE your wardrobe for good (discarded)" };
      let pieces = (p.garmentIds ?? []) as string[];
      if (p.moveStock && pieces.length === 0) pieces = (await all<{ garment_id: string }>(db, "SELECT garment_id FROM lifecycle_project_items WHERE user_id = ? AND project_id = ?", userId, p.projectId)).map((r) => r.garment_id);
      const stock = p.moveStock && moves[p.kind] ? ` ${await g(pieces)} ${moves[p.kind]}.` : "";
      return `Record ${quoted(words(p.kind))} on the project ${project ? quoted(project.title) : quoted(p.projectId)}${minor(p.proceedsMinor, p.currency) ? `, proceeds ${minor(p.proceedsMinor, p.currency)}` : ""}${p.nextAction ? `, next step ${quoted(p.nextAction)}` : ""}.${stock}`;
    }
    case "lifecycle.authorize_action": {
      const project = await first<{ title: string }>(db, "SELECT title FROM lifecycle_projects WHERE user_id = ? AND project_id = ?", userId, p.projectId);
      return `AUTHORIZE the assistant to ${words(p.action)} for the project ${project ? quoted(project.title) : quoted(p.projectId)}, within the scope ${quoted(p.scope)}. It will not ask again for this project.`;
    }
    case "job.create":
      if (p.kind === "email_investigation") return `Search your mailbox for purchases from ${p.params?.from} to ${p.params?.to}${(p.params?.merchants ?? []).length > 0 ? ` at ${list((p.params.merchants as string[]).map((m) => quoted(m)))}` : ""}${p.params?.importAuthorizedBy ? " and LOG the orders it finds (as ordered, not arrived)" : "; found orders are kept as a draft and nothing is logged"}.`;
      return `Start background work (${words(p.kind)}): ${quoted(p.title)}.`;
    case "reminder.set":
      return `${p.reminderId ? "Change the reminder to" : "Set a reminder"} ${quoted(p.title)} for ${p.dueAt}${p.note ? `, note ${quoted(p.note)}` : ""}${p.url ? `, link ${quoted(p.url)}` : ""}.`;
    case "reminder.cancel": {
      const r = await first<{ title: string }>(db, "SELECT title FROM reminders WHERE user_id = ? AND reminder_id = ?", userId, p.reminderId);
      return `Remove the reminder ${r ? quoted(r.title) : quoted(p.reminderId)}.`;
    }
    case "settings.update":
      // Each setting is listed after this sentence by name and value, never as raw JSON.
      return "Change your settings.";
    case "memory.record_conclusion":
      return `Remember as ${p.status === "active" ? "settled" : "a candidate"} (${words(p.kind)}), attributed to ${p.speaker === "owner" ? "you" : "the assistant"}: ${quoted(p.text)}.`;
    case "memory.set_status": {
      const m = await first<{ text: string }>(db, "SELECT text FROM memory_conclusions WHERE user_id = ? AND conclusion_id = ?", userId, p.conclusionId);
      return `${p.status === "retired" ? "Retire" : "Confirm"} the remembered conclusion ${m ? quoted(m.text) : quoted(p.conclusionId)}${p.correctedText ? `, corrected to ${quoted(p.correctedText)}` : ""}.`;
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
      return c ? `Undo an earlier change (${quoted(c.type)}) whose receipt read ${quoted(was)}.` : `Undo a change that is not on record (${quoted(p.commandId)}).`;
    }
    default:
      // No sentence of its own: every field is listed, in full, by describeChange.
      return `Carry out ${quoted(type)}.`;
  }
}

/**
 * The versions a proposal was built against, as the command's expected versions: a proposal about a
 * record that has changed since is refused as stale when the owner confirms it.
 *
 * Every proposal that rewrites, moves, receives or removes a wardrobe piece carries that piece's version
 * as read when the proposal was made. The commands check a piece's state themselves, but state is not
 * version: a piece corrected, renamed, moved, received or retired after the owner was shown the summary is
 * no longer the piece the summary described, and the command service refuses the confirmation with
 * `conflict`. The version used is the count of changes to the piece's RECORD (`garment_record`, registered
 * in commands/index.ts), not the piece's own version, which also moves with every wear, wash and laundry
 * cycle: a wear report must not discard a waiting request (third review, point G). Proposals that
 * only refer to a piece without changing its record (a restriction, a return, a project being opened, a
 * wear or wash report that became a request) carry no garment version: their commands refuse a piece
 * that is gone, and a wear or wash report is never discarded over another change to the piece.
 */
export async function expectedVersionsFor(db: Db, userId: string, type: string, p: P): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  const garment = async (id: unknown) => {
    if (typeof id !== "string") return;
    const row = await first<{ changes: number }>(
      db,
      `SELECT COUNT(*) AS changes FROM command_entities e JOIN commands c ON c.user_id = e.user_id AND c.command_id = e.command_id WHERE e.user_id = ? AND e.kind = 'garment' AND e.entity_id = ? AND (substr(c.type, 1, 8) = 'garment.' OR c.type IN (${RECORD_CHANGING_TYPES.map((t) => `'${t}'`).join(", ")}))`,
      userId, id,
    );
    if (await first(db, "SELECT 1 AS x FROM garments WHERE user_id = ? AND garment_id = ?", userId, id)) out[`garment_record:${id}`] = row?.changes ?? 0;
  };
  const versioned = async (kind: string, table: string, column: string, id: unknown) => {
    if (typeof id !== "string") return;
    const row = await first<{ version: number }>(db, `SELECT version FROM ${table} WHERE user_id = ? AND ${column} = ?`, userId, id);
    if (row) out[`${kind}:${id}`] = row.version;
  };
  switch (type) {
    case "garment.correct":
    case "garment.retire":
    case "garment.move":
    case "garment.receive":
    case "garment.add_alias":
    case "assistant.report_arrival":
      await garment(p.garmentId);
      break;
    case "return.update_case":
    case "return.link_exchange":
      await versioned("return_case", "return_cases", "case_id", p.caseId);
      break;
    case "lifecycle.record_event": {
      await versioned("lifecycle_project", "lifecycle_projects", "project_id", p.projectId);
      // A project event that also moves or retires stock is held to the versions of the pieces it moves:
      // the ones it names, or every piece of the project when it names none (as the command does).
      if (p.moveStock && STOCK_MOVING_EVENTS.has(String(p.kind))) {
        let pieces = Array.isArray(p.garmentIds) ? (p.garmentIds as unknown[]) : [];
        if (pieces.length === 0 && typeof p.projectId === "string") pieces = (await all<{ garment_id: string }>(db, "SELECT garment_id FROM lifecycle_project_items WHERE user_id = ? AND project_id = ?", userId, p.projectId)).map((r) => r.garment_id);
        for (const id of new Set(pieces)) await garment(id);
      }
      break;
    }
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
