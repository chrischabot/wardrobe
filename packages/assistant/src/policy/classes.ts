/**
 * How a change asked for in conversation or by a connected assistant takes effect: the owner's decision of
 * 2026-10-05, "Follow the specification everywhere" (library contract "Changes apply at once with undo on
 * every surface"). This one classification drives the assistant's tool runtime, the ledger commit hook
 * (commands/index.ts), the Worker's relayed-turn guard, the typed MCP policy and the published
 * `consequential` flag. Four classes:
 *
 *   - `observation`: a wear or wash report. Recorded at once, but from a conversation turn only when trusted
 *     code (policy/report.ts) finds that very report in the owner's own words of the message - its kind,
 *     its date and every garment, named by the owner or attached and pointed at - with that provenance kept
 *     on the turn. A report that does not pass is kept as a request: a wear or wash report must represent
 *     what the owner actually reported. No refusal for a restricted piece: an observation is a fact.
 *   - `bookkeeping`: the assistant's own working records that hold no fact about the wardrobe, the profile
 *     or the owner (a research note, a shopping candidate outside the wardrobe, a product observation or
 *     fit assessment, a research job, a memory CANDIDATE awaiting the owner). Recorded at once.
 *   - `direction` (the default): every other owner-facing change - adding, correcting, moving, retiring or
 *     receiving a piece, aliases, restrictions added, standing directions, day briefs, profile amendments,
 *     measurements, comfort feedback, wear corrections, orders, returns, lifecycle work, reminders, memory,
 *     settings, pause and resume, trips, board choices, laundry, undo. Applied at once when it matches the
 *     8-form owner allow-list (policy/intent.ts) or a verified healing statement (policy/ended.ts), with a
 *     receipt and, where the ledger has one, an undo; otherwise kept as a one-tap request in the app.
 *   - `confirm`: the contract's section 3 list (`SECTION3_CONFIRM_TYPES`): irreversible erasure or rewrite,
 *     authorization towards another party, what a model or an outside connection may reach, and rewriting
 *     the profile document. Kept as a request that only the signed-in owner confirms in the app; a
 *     connected assistant can cause one but never list or confirm it.
 *
 * Restrictions: a connected assistant can never lift one, and no assistant on any channel can undo the
 * command that recorded one (`forbiddenForConnectedAssistant`, and the domain's own `restriction.add` undo).
 */
import { first, type Db } from "@garderobe/domain";

export type ChangeClass = "observation" | "bookkeeping" | "direction" | "confirm";

export const OBSERVATION_TYPES: ReadonlySet<string> = new Set(["wear.record", "care.mark_dirty", "care.washed"]);

/** The contract's section 3: the only changes that wait for the signed-in owner's confirmation in the app. */
export const SECTION3_CONFIRM_TYPES: ReadonlySet<string> = new Set([
  // Irreversible erasure or rewrite, with no undo.
  "conversation.forget_source",
  "media.delete_asset",
  "garment.merge",
  "garment.remove_fabricated",
  // Authorization towards another party.
  "lifecycle.authorize_action",
  // What a model or an outside connection may reach.
  "connection.register",
  "connection.set_tool_groups",
  "connection.set_status",
  "inference.set_routing",
  // Rewriting the profile document.
  "style.save_document",
  "style.import_document",
]);

/** Lifting a restriction: refused outright for a connected assistant, whatever it relays. */
export const RESTRICTION_LIFT_TYPES: ReadonlySet<string> = new Set(["assistant.lift_restriction", "restriction.resolve"]);

const BOOKKEEPING_TYPES = new Set(["product.record", "product.record_observation", "product.record_fit_assessment", "research.save_note"]);
/** Background jobs the assistant may start by itself: they read public pages or its own records, never the owner's mailbox or files. */
const BOOKKEEPING_JOB_KINDS = new Set(["product_investigation", "historical_research", "other"]);

/**
 * No turn may apply more than this many changes (observations and directions; bookkeeping is not counted).
 * A SAFETY ADDITION, not a specification requirement: the coordinator's decision of 2026-10-12 under the
 * owner's standing delegation. Also the bound of one command's reach: a single command that would change more
 * pieces than this (`isUnboundedChange`) waits for the owner, so the cap cannot be got round in one command.
 */
export const MAX_APPLIED_CHANGES_PER_TURN = 20;

/**
 * Jobs that read the owner's own outside accounts (the mailbox, a spreadsheet): what an outside connection
 * may reach (contract section 3; coordinator rulings of 2026-10-12 and 2026-10-13). On every channel, even
 * when the owner asks for it in conversation, they wait for the signed-in owner's confirmation in the app.
 */
export const OUTSIDE_REACH_JOB_KINDS: ReadonlySet<string> = new Set(["email_investigation", "sheet_import"]);

/**
 * A command whose reach is not bounded by named pieces: a whole care channel, a bulk correction without an
 * expected count or above the per-turn cap, or any list in the payload longer than the cap. Such a change
 * from an assistant waits for the owner in the app (API/MCP thread and assistant, agreed 2026-10-13).
 */
export function isUnboundedChange(type: string, payload: Record<string, unknown>, indirectPieces = 0): boolean {
  if (payload["allOfChannel"]) return true;
  // A command that reaches pieces it does not name (a project event moving every piece of the project), or
  // names more distinct pieces across its fields than the per-turn cap.
  const namedPieces = new Set<string>();
  const addPiece = (v: unknown) => {
    if (typeof v === "string" && v.length > 0) namedPieces.add(v);
  };
  addPiece(payload["garmentId"]);
  for (const field of ["garmentIds", "add", "remove"]) {
    const arr = payload[field];
    if (Array.isArray(arr)) for (const v of arr) addPiece(v);
  }
  if (Array.isArray(payload["items"])) {
    for (const item of payload["items"]) {
      if (item && typeof item === "object") addPiece((item as Record<string, unknown>)["garmentId"]);
    }
  }
  if (namedPieces.size + indirectPieces > MAX_APPLIED_CHANGES_PER_TURN) return true;
  if (type === "garment.bulk_correct") {
    const expected = payload["expectedCount"];
    if (typeof expected !== "number" || expected > MAX_APPLIED_CHANGES_PER_TURN) return true;
  }
  const tooLong = (value: unknown, depth: number): boolean => {
    if (Array.isArray(value)) return value.length > MAX_APPLIED_CHANGES_PER_TURN || (depth < 3 && value.some((v) => tooLong(v, depth + 1)));
    if (value && typeof value === "object" && depth < 3) return Object.values(value).some((v) => tooLong(v, depth + 1));
    return false;
  };
  return tooLong(payload, 0);
}

/**
 * How many pieces a command reaches without naming them, read from the ledger: a project event that moves
 * stock with no pieces named moves every piece of the project. Zero for every other command.
 */
export async function indirectReach(db: Db, userId: string, type: string, payload: Record<string, unknown>): Promise<number> {
  if (type === "lifecycle.record_event" && payload["moveStock"] === true && typeof payload["projectId"] === "string") {
    const named = Array.isArray(payload["garmentIds"]) ? (payload["garmentIds"] as unknown[]).length : 0;
    if (named > 0) return 0;
    const row = await first<{ n: number }>(db, "SELECT COUNT(*) AS n FROM lifecycle_project_items WHERE user_id = ? AND project_id = ?", userId, payload["projectId"]);
    return Number(row?.n ?? 0);
  }
  return 0;
}

/** The class of a change. The same on every surface. `indirectPieces` is `indirectReach` of the command. */
export function classifyChange(type: string, payload: Record<string, unknown>, _channel?: string, indirectPieces = 0): ChangeClass {
  if (SECTION3_CONFIRM_TYPES.has(type)) return "confirm";
  if (isUnboundedChange(type, payload, indirectPieces)) return "confirm";
  if (type === "job.create" && OUTSIDE_REACH_JOB_KINDS.has(String(payload["kind"]))) return "confirm";
  if (OBSERVATION_TYPES.has(type)) return "observation";
  if (BOOKKEEPING_TYPES.has(type)) return "bookkeeping";
  if (type === "job.create" && BOOKKEEPING_JOB_KINDS.has(String(payload["kind"]))) return "bookkeeping";
  // Only something the assistant itself inferred, saved as a candidate for the owner to confirm or discard.
  if (type === "memory.record_conclusion" && payload["status"] === "candidate" && payload["speaker"] === "assistant") return "bookkeeping";
  return "direction";
}

/** Whether a type waits for the signed-in owner (the published `consequential` flag, before lifts and internal types). */
export function isConsequential(type: string): boolean {
  return SECTION3_CONFIRM_TYPES.has(type);
}

/** Fields of particular commands that name records without the ...Id naming (garment references of a wear correction). */
const COMMAND_REF_FIELDS: Record<string, readonly string[]> = {
  "wear.amend": ["add", "remove"],
};

/**
 * Every record identifier a payload refers to (any field named ...Id or ...Ids, to three levels, plus the
 * command's own reference fields when its type is given), sorted. A turn's grant records these, and the
 * ledger hook accepts a command only when a grant of its type covers every one of them: a grant given for
 * one restriction, return or piece never authorizes a change to another.
 */
export function targetIdsOf(payload: Record<string, unknown>, type?: string): string[] {
  const out = new Set<string>();
  const walk = (value: unknown, key: string, depth: number) => {
    if (/(?:Id|Ids)$/.test(key)) {
      if (typeof value === "string" && value.length > 0) out.add(value);
      else if (Array.isArray(value)) for (const v of value) if (typeof v === "string" && v.length > 0) out.add(v);
    }
    if (depth >= 3) return;
    if (Array.isArray(value)) for (const v of value) walk(v, "", depth + 1);
    else if (value && typeof value === "object") for (const [k, v] of Object.entries(value)) walk(v, k, depth + 1);
  };
  walk(payload, "", 0);
  for (const field of type ? (COMMAND_REF_FIELDS[type] ?? []) : []) {
    const value = payload[field];
    if (typeof value === "string" && value.length > 0) out.add(value);
    else if (Array.isArray(value)) for (const v of value) if (typeof v === "string" && v.length > 0) out.add(v);
  }
  return [...out].sort();
}

/** Whether a recorded grant's targets cover every record this payload refers to. A grant without a target list covers nothing that has one. */
export function grantCoversTargets(grant: { targets?: unknown }, payload: Record<string, unknown>, type?: string): boolean {
  const wanted = targetIdsOf(payload, type);
  if (wanted.length === 0) return true;
  const held = new Set(Array.isArray(grant.targets) ? grant.targets.filter((t): t is string => typeof t === "string") : []);
  return wanted.every((id) => held.has(id));
}

/**
 * Why a connected assistant may never carry out this change, on any path, or null when it may (as a
 * receipt or, for section 3, as a request). `target` is the command an undo would take back. The answer
 * is `forbidden`, not a request: a relayed statement cannot be verified as the owner's (contract section 3).
 */
export function forbiddenForConnectedAssistant(type: string, _payload: Record<string, unknown>, target?: { type: string } | null): "restriction_lift_not_relayed" | "restriction_not_lifted_by_undo" | null {
  if (RESTRICTION_LIFT_TYPES.has(type)) return "restriction_lift_not_relayed";
  if (type === "command.undo" && target && target.type === "restriction.add") return "restriction_not_lifted_by_undo";
  return null;
}

/**
 * Whether a change of this type can be applied from a conversation turn on the owner's words at all
 * (everything but section 3). A direction still needs the owner's words in the turn and an observation the
 * owner's report; the ledger hook checks both.
 */
export function mayCommitFromConversation(type: string, payload: Record<string, unknown>, channel?: string): boolean {
  return classifyChange(type, payload, channel) !== "confirm";
}

/** Commands other than `garment.*` that change a piece's record or whether it is in the wardrobe at all (see the `garment_record` version in commands/index.ts). */
export const RECORD_CHANGING_TYPES = ["assistant.report_arrival", "lifecycle.record_event", "stock.reconcile", "purchase.mark_delivered", "command.undo"];

const recordChange = (alias: string): string =>
  `(substr(${alias}.type, 1, 8) = 'garment.' OR ${alias}.type IN (${RECORD_CHANGING_TYPES.filter((t) => t !== "command.undo").map((t) => `'${t}'`).join(", ")}))`;

/**
 * How many times a piece's RECORD was changed (parameters: user ID, garment ID): the version a waiting
 * request about that piece is held to. The one statement serves both the proposal (policy/describe.ts)
 * and the ledger's check when it is confirmed (commands/index.ts), so the two cannot drift apart. An undo
 * counts only when the change it undid was itself a change to the record: undoing a wear or wash report
 * leaves the record as the owner was shown it, and must not discard a waiting request (change review,
 * 2026-10-03).
 */
export const GARMENT_RECORD_VERSION_SQL = `SELECT COUNT(*) AS version FROM command_entities e JOIN commands c ON c.user_id = e.user_id AND c.command_id = e.command_id WHERE e.user_id = ? AND e.kind = 'garment' AND e.entity_id = ? AND (${recordChange("c")} OR (c.type = 'command.undo' AND EXISTS (SELECT 1 FROM commands u WHERE u.user_id = c.user_id AND u.command_id = c.undoes_command_id AND ${recordChange("u")})))`;
