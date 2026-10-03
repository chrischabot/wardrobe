/**
 * How a change asked for in conversation takes effect (the owner's decision of 2026-10-01).
 *
 * Conversation text is never authority for a sensitive change, on any channel. Two reviews showed that
 * no reading of the owner's words in code can establish what was meant, so there are exactly three
 * classes and the default is the strict one:
 *
 *   - `observation`: a wear or wash report. Recorded without a tap, but only when trusted code
 *     (policy/report.ts) finds the report itself in the owner's own words of that message: a clause in
 *     the form of a first-person report of that kind, whose date that code fixed and whose garments the
 *     clause names (or the owner attached and the clause points at), with that provenance kept on the
 *     turn. Anything else - a mention, a question, a negation, a plan, a group ("all my socks"), a date
 *     the sentence does not fix - becomes a proposal instead. A wear CORRECTION and a comfort note are
 *     never recorded without a tap (third review, finding A): they are `confirm`.
 *   - `bookkeeping`: the assistant's own working records that hold no fact about the wardrobe, the
 *     profile or the owner (a research note, a shopping candidate outside the wardrobe, a product
 *     observation or fit assessment, a research job, a memory CANDIDATE awaiting the owner). Recorded
 *     without owner words.
 *   - `confirm`: everything else. The assistant records a PROPOSAL carrying a summary written by trusted
 *     code of the exact change; the ledger changes only when the signed-in owner confirms that exact
 *     proposal in the app (the Worker's owner-only proposals routes). A connected assistant can cause a
 *     proposal but can never list or confirm one.
 *
 * A command type that is not listed here is `confirm`.
 */
export type ChangeClass = "observation" | "bookkeeping" | "confirm";

export const OBSERVATION_TYPES = new Set(["wear.record", "care.mark_dirty", "care.washed"]);

const BOOKKEEPING_TYPES = new Set(["product.record", "product.record_observation", "product.record_fit_assessment", "research.save_note"]);
/** Background jobs the assistant may start by itself: they read public pages or its own records, never the owner's mailbox or files. */
const BOOKKEEPING_JOB_KINDS = new Set(["product_investigation", "historical_research", "other"]);

/**
 * What a connected assistant's relayed words may record straight away. The Worker enforces the same list
 * at its own boundary; a memory candidate or a comfort note relayed by another model waits for the owner.
 */
const RELAYED_BOOKKEEPING = new Set(["product.record", "product.record_observation", "product.record_fit_assessment", "research.save_note", "job.create"]);
const RELAYED_OBSERVATIONS = new Set(["wear.record", "care.mark_dirty", "care.washed"]);

export function classifyChange(type: string, payload: Record<string, unknown>, channel: string): ChangeClass {
  const relayed = channel === "mcp";
  if (OBSERVATION_TYPES.has(type)) return relayed && !RELAYED_OBSERVATIONS.has(type) ? "confirm" : "observation";
  let bookkeeping = BOOKKEEPING_TYPES.has(type);
  if (type === "job.create") bookkeeping = BOOKKEEPING_JOB_KINDS.has(String(payload["kind"]));
  // Only something the assistant itself inferred, saved as a candidate for the owner to confirm or discard.
  if (type === "memory.record_conclusion") bookkeeping = payload["status"] === "candidate" && payload["speaker"] === "assistant";
  if (!bookkeeping) return "confirm";
  return relayed && !RELAYED_BOOKKEEPING.has(type) ? "confirm" : "bookkeeping";
}

/**
 * The ledger-side backstop (registered as a commit hook by registerAssistant): whether a command that
 * arrives from a conversation turn on the strength of conversation text may commit at all. Tool code
 * already turns everything else into a proposal; this refuses it again at the ledger, so that no tool,
 * present or future, can commit a sensitive change from a turn.
 */
export function mayCommitFromConversation(type: string, payload: Record<string, unknown>, channel: string): boolean {
  return classifyChange(type, payload, channel) !== "confirm";
}

/** Commands other than `garment.*` that change a piece's record or whether it is in the wardrobe at all (see the `garment_record` version in commands/index.ts). */
export const RECORD_CHANGING_TYPES = ["assistant.report_arrival", "lifecycle.record_event", "stock.reconcile", "purchase.mark_delivered", "command.undo"];

/**
 * Everyday, undoable actions the owner decided (2026-10-03) a connected assistant may carry out directly
 * through the product's own typed surface, each with a receipt and undo: choosing from the published
 * outfit board, laundry pickup and packing checks. (A laundry return has no undo in the ledger, so it
 * stays a request.) The Worker's boundary (apps/worker/src/mcp/policy.ts) decides when a typed command of
 * these types may run; this list only lets the ledger hook pass a command that names no conversation
 * turn. It never makes conversation text authority for anything.
 */
export const EVERYDAY_DIRECT_TYPES: ReadonlySet<string> = new Set(["board.select", "laundry.collect", "stock.pack", "stock.unpack"]);
