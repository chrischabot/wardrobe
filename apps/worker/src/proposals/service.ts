/**
 * Proposals and the owner's decision on them.
 *
 * The assistant never changes what the owner owns, the profile, a rule, a measurement or a restriction on
 * words that reached it through a connected assistant, and a read-only connection changes nothing at all.
 * In both cases the assistant workstream records the requested change as a PROPOSAL on the turn (the
 * typed command and its payload, exactly as it would have been executed). This module is the other half:
 * the owner sees the pending proposals in the app and confirms or rejects each one.
 *
 * Authority: a confirmation is the owner's tap. It is executed by the shared command service as the
 * signed-in owner with `owner_tap`, so the command's own checks (schema, expected state, restrictions on
 * who may run it) apply exactly as if the owner had made the change by hand. These are app routes under
 * Cloudflare Access; an MCP grant is not accepted there, there is no MCP tool for them, and the handler
 * additionally requires an owner principal on an app channel, so a connected assistant cannot confirm
 * what it proposed.
 *
 * Proposals come from two places and are decided the same way. The assistant workstream keeps what it
 * could not do on a turn (its `proposals_json`); those are read from there and nothing is copied. A
 * sensitive typed command sent by a connected assistant, and a command the assistant tried on relayed
 * text that is not allowed there, are kept in `submitted_proposals` (see `store.ts`). Only the decision
 * is stored here (`proposal_decisions`).
 *
 * What the owner confirms is exactly what runs: the identifier is derived from the origin and the exact
 * command, so a request that was changed is a different proposal. The summary shown is written by
 * trusted code from the command type and payload: the assistant workstream's for a turn's proposal,
 * this module's for the others; never by a model or the requesting assistant. A
 * proposal that names the versions it was made against runs with them, so one that has gone stale is
 * refused by the command and nothing changes.
 */
import type { CommandReceipt } from "@garderobe/contracts";
import { all, canonicalJson, first, json as parseJson, prepare, stmt, toInstant, type Principal } from "@garderobe/domain";
import type { App } from "../app.ts";
import { sha256Hex } from "../crypto.ts";
import { ApiException } from "../errors.ts";
import { findSubmittedProposal, grantOfAuthRef, listSubmittedProposals, listWaitingSubmittedProposals, notShownSummary, PROPOSAL_LIFETIME_MS, submittedExpectedVersions, submittedPayload, summaryForOwner, type SubmittedProposalRow } from "./store.ts";

export { PROPOSAL_LIFETIME_MS };

/** How many decided or expired turns and kept requests the owner's history shows. What is still waiting is never cut. */
const HISTORY_LIMIT = 200;

export interface Proposal {
  proposalId: string;
  /** The turn (and run) that produced it; empty for a typed command, which has no turn. */
  turnId: string;
  /** The typed command that would be executed. */
  type: string;
  summary: string;
  payload: Record<string, unknown>;
  proposedAt: string;
  expiresAt: string;
  /** Where the request came from: the channel and, for a connected assistant, the name the owner approved it under. */
  source: { channel: string; assistantName: string | null };
  state: "pending" | "confirmed" | "rejected" | "expired";
  decidedAt: string | null;
  commandId: string | null;
}

interface TurnRow {
  turn_id: string;
  channel: string;
  auth_ref: string;
  created_at: string;
  proposals_json: string;
}
interface DecisionRow {
  proposal_id: string;
  decision: "confirmed" | "rejected";
  command_id: string | null;
  decided_at: string;
}

/**
 * The identifier of a proposal the assistant recorded on a turn. It covers everything the owner is asked
 * to confirm: the command and its exact payload, the summary that is shown for it and the versions it
 * would run against. A stored proposal that differs in any of these is a different proposal, so a
 * confirmation can only ever apply to the text the owner was shown.
 */
const proposalIdOf = async (turnId: string, type: string, payload: unknown, summary: string, expectedVersions: Record<string, number>): Promise<string> =>
  `prp_${(await sha256Hex(`proposal\u0000${turnId}\u0000${type}\u0000${canonicalJson({ payload, summary, expectedVersions })}`)).slice(0, 32)}`;

/** A proposal with what is needed to run it; only the `Proposal` part leaves this module. */
interface Held {
  proposal: Proposal;
  /** What the decision row records as its origin: the turn, or the grant a typed command came from. */
  decisionRef: string;
  expectedVersions: Record<string, number>;
  occurredAt: string | null;
  /** False when the request could not be shown to the owner in full: it can be rejected, never confirmed. */
  showable: boolean;
}

const TURN_COLUMNS = "t.turn_id, t.channel, t.auth_ref, t.created_at, t.proposals_json";
/** A decision on one of the turn's own proposals (not on a request kept from it in `submitted_proposals`). */
const TURN_DECISIONS = "(SELECT COUNT(*) FROM proposal_decisions d WHERE d.user_id = t.user_id AND d.turn_id = t.turn_id AND NOT EXISTS (SELECT 1 FROM submitted_proposals s WHERE s.user_id = d.user_id AND s.proposal_id = d.proposal_id))";

/** Turns that still hold a proposal the owner has not decided and that has not expired. Not truncated. */
const waitingTurns = (app: App, userId: string, nowMs: number): Promise<TurnRow[]> =>
  all<TurnRow>(
    app.db,
    `SELECT ${TURN_COLUMNS} FROM assistant_turns t WHERE t.user_id = ? AND t.proposals_json != '[]' AND unixepoch(t.created_at) > ? AND json_array_length(t.proposals_json) > ${TURN_DECISIONS}`,
    userId, Math.floor((nowMs - PROPOSAL_LIFETIME_MS) / 1000),
  );

/** The newest turns that hold proposals, decided or not, from `offset` on. */
const recentTurns = (app: App, userId: string, limit: number, offset = 0): Promise<TurnRow[]> =>
  all<TurnRow>(app.db, `SELECT ${TURN_COLUMNS} FROM assistant_turns t WHERE t.user_id = ? AND t.proposals_json != '[]' ORDER BY unixepoch(t.created_at) DESC, t.turn_id LIMIT ? OFFSET ?`, userId, limit, offset);

const uniqueBy = <T>(rows: T[], key: (row: T) => string): T[] => [...new Map(rows.map((row) => [key(row), row])).values()];

/** The proposals held on these turns and in these kept requests, newest first, each with its state. */
async function build(app: App, userId: string, turns: TurnRow[], submitted: SubmittedProposalRow[], nowMs: number): Promise<Held[]> {
  if (turns.length === 0 && submitted.length === 0) return [];
  const decisions = new Map((await all<DecisionRow>(app.db, "SELECT proposal_id, decision, command_id, decided_at FROM proposal_decisions WHERE user_id = ?", userId)).map((d) => [d.proposal_id, d]));
  const grants = new Map((await all<{ grant_id: string; client_name: string }>(app.db, "SELECT grant_id, client_name FROM mcp_grants WHERE user_id = ?", userId)).map((g) => [g.grant_id, g.client_name]));
  const out: Held[] = [];
  const add = (input: { proposalId: string; legacyId?: string; turnId: string; decisionRef: string; type: string; summary: string; showable: boolean; payload: Record<string, unknown>; proposedAt: string; channel: string; assistantName: string | null; expectedVersions: Record<string, number>; occurredAt: string | null }) => {
    // A decision recorded before the identifier covered the summary and versions is still that proposal's decision.
    const decision = decisions.get(input.proposalId) ?? (input.legacyId ? decisions.get(input.legacyId) : undefined);
    const expiresAtMs = Date.parse(input.proposedAt) + PROPOSAL_LIFETIME_MS;
    out.push({
      proposal: {
        proposalId: input.proposalId,
        turnId: input.turnId,
        type: input.type,
        // A turn's proposal carries the summary the assistant workstream's trusted code composed; a kept
        // request is described by the same code each time it is read (`summaryForOwner`).
        summary: input.summary,
        payload: input.payload,
        proposedAt: input.proposedAt,
        expiresAt: toInstant(expiresAtMs),
        source: { channel: input.channel, assistantName: input.assistantName },
        state: decision ? decision.decision : nowMs >= expiresAtMs ? "expired" : "pending",
        decidedAt: decision?.decided_at ?? null,
        commandId: decision?.command_id ?? null,
      },
      decisionRef: input.decisionRef,
      expectedVersions: input.expectedVersions,
      occurredAt: input.occurredAt,
      showable: input.showable,
    });
  };
  const grantOfTurn = new Map(turns.map((t) => [t.turn_id, grantOfAuthRef(t.auth_ref)]));
  for (const turn of turns) {
    const grantId = grantOfTurn.get(turn.turn_id) ?? null;
    for (const p of parseJson<{ type?: unknown; summary?: unknown; payload?: unknown; expectedVersions?: unknown }[]>(turn.proposals_json, [])) {
      if (typeof p.type !== "string" || !p.payload || typeof p.payload !== "object") continue;
      const payload = p.payload as Record<string, unknown>;
      // The versions the proposal was built against, when the assistant recorded them: passed to the command on confirm.
      const expectedVersions = p.expectedVersions && typeof p.expectedVersions === "object" ? Object.fromEntries(Object.entries(p.expectedVersions as Record<string, unknown>).filter((e): e is [string, number] => typeof e[1] === "number")) : {};
      // The summary the assistant workstream's trusted code composed is what the owner is shown, so it is part of the identifier.
      // A stored proposal without one was never shown in words: it is listed as such and cannot be confirmed.
      const showable = typeof p.summary === "string" && p.summary.length > 0;
      const summary = showable ? (p.summary as string) : notShownSummary(p.type);
      add({ proposalId: await proposalIdOf(turn.turn_id, p.type, payload, summary, expectedVersions), legacyId: `prp_${(await sha256Hex(`proposal\u0000${turn.turn_id}\u0000${p.type}\u0000${JSON.stringify(payload)}`)).slice(0, 32)}`, turnId: turn.turn_id, decisionRef: turn.turn_id, type: p.type, summary, showable, payload, proposedAt: turn.created_at, channel: turn.channel, assistantName: grantId ? (grants.get(grantId) ?? null) : null, expectedVersions, occurredAt: null });
    }
  }
  const payloads = submitted.map((row) => submittedPayload(row));
  for (const [i, row] of submitted.entries()) {
    let grantId = row.grant_id;
    if (!grantId && row.turn_id) {
      const authRef = grantOfTurn.has(row.turn_id) ? null : (await first<{ auth_ref: string }>(app.db, "SELECT auth_ref FROM assistant_turns WHERE user_id = ? AND turn_id = ?", userId, row.turn_id))?.auth_ref;
      grantId = grantOfTurn.get(row.turn_id) ?? grantOfAuthRef(authRef);
    }
    // In words, by the same trusted code that describes a request made in conversation. A stored request that
    // cannot be described in full stays on the list with a plain statement, to be rejected; it is never
    // shown as raw fields and never confirmable.
    const { summary, showable } = await summaryForOwner(app.db, userId, row.command_type, payloads[i]!);
    add({ proposalId: row.proposal_id, turnId: row.turn_id ?? "", decisionRef: row.turn_id ?? row.source_ref, type: row.command_type, summary, showable, payload: payloads[i]!, proposedAt: row.created_at, channel: "mcp", assistantName: grantId ? (grants.get(grantId) ?? null) : null, expectedVersions: submittedExpectedVersions(row), occurredAt: row.occurred_at });
  }
  return out.sort((a, b) => Date.parse(b.proposal.proposedAt) - Date.parse(a.proposal.proposedAt) || (a.proposal.proposalId < b.proposal.proposalId ? -1 : 1));
}

/**
 * The owner's proposals, newest first. `pending` (the default) is everything that still waits for a
 * decision: it is read by state, not as the newest so-many turns, so a request cannot drop off the list
 * because newer ones arrived. `all` adds the recent history of decided and expired ones.
 */
export async function listProposals(app: App, principal: Principal, opts: { state?: "pending" | "all" } = {}): Promise<Proposal[]> {
  const userId = principal.userId;
  const nowMs = app.now();
  let turns = await waitingTurns(app, userId, nowMs);
  let submitted = await listWaitingSubmittedProposals(app.db, userId, nowMs);
  if (opts.state === "all") {
    turns = uniqueBy([...turns, ...(await recentTurns(app, userId, HISTORY_LIMIT))], (t) => t.turn_id);
    submitted = uniqueBy([...submitted, ...(await listSubmittedProposals(app.db, userId, HISTORY_LIMIT))], (s) => s.proposal_id);
  }
  const proposals = (await build(app, userId, turns, submitted, nowMs)).map((h) => h.proposal);
  return opts.state === "all" ? proposals : proposals.filter((p) => p.state === "pending");
}

/** One proposal by identifier, however old it is and however many came after it. */
async function findHeld(app: App, userId: string, proposalId: string): Promise<Held> {
  const nowMs = app.now();
  const pick = (list: Held[]) => list.find((h) => h.proposal.proposalId === proposalId);
  const kept = await findSubmittedProposal(app.db, userId, proposalId);
  if (kept) {
    const found = pick(await build(app, userId, [], [kept], nowMs));
    if (found) return found;
  }
  // A turn's proposal is identified by a digest of its content, so its turn is found through the decision
  // already taken on it, or by going through the owner's turns that hold proposals, a page at a time.
  const decided = await first<{ turn_id: string }>(app.db, "SELECT turn_id FROM proposal_decisions WHERE user_id = ? AND proposal_id = ?", userId, proposalId);
  if (decided) {
    const found = pick(await build(app, userId, await all<TurnRow>(app.db, `SELECT ${TURN_COLUMNS} FROM assistant_turns t WHERE t.user_id = ? AND t.turn_id = ?`, userId, decided.turn_id), [], nowMs));
    if (found) return found;
  }
  const page = 200;
  for (let offset = 0; ; offset += page) {
    const turns = await recentTurns(app, userId, page, offset);
    const found = pick(await build(app, userId, turns, [], nowMs));
    if (found) return found;
    if (turns.length < page) break;
  }
  throw new ApiException("not_found", "that proposal was not found");
}

/** The state of one proposal by identifier, for the connection that submitted it: its own request, with the summary the owner is shown. */
export async function submittedProposalState(app: App, userId: string, proposalId: string): Promise<{ state: Proposal["state"]; commandId: string | null; summary: string; expiresAt: string }> {
  const { proposal } = await findHeld(app, userId, proposalId);
  return { state: proposal.state, commandId: proposal.commandId, summary: proposal.summary, expiresAt: proposal.expiresAt };
}

/** Only the signed-in owner, in the app or on the private web board, decides a proposal. */
function assertOwnerInApp(principal: Principal): void {
  if (principal.actor !== "owner" || (principal.channel !== "ios" && principal.channel !== "web")) {
    throw new ApiException("forbidden", "a proposal is confirmed or rejected by the owner in the Garderobe app", { reason: "owner_in_app_required" });
  }
}

export interface DecisionResult {
  proposal: Proposal;
  /** The receipt of the change, when it was confirmed. */
  receipt: CommandReceipt | null;
  replayed: boolean;
}

/**
 * Confirm or reject one proposal. Confirming executes the proposed command once (the proposal is its
 * idempotency key), as the owner; if the command is refused (the garment is gone, the state changed),
 * the refusal is returned and the proposal stays pending. A decision is final: a rejected proposal is
 * not confirmed later and a confirmed one is not executed again.
 */
export async function decideProposal(app: App, principal: Principal, proposalId: string, decision: "confirm" | "reject"): Promise<DecisionResult> {
  assertOwnerInApp(principal);
  const userId = principal.userId;
  const { proposal, decisionRef, expectedVersions, occurredAt, showable } = await findHeld(app, userId, proposalId);
  const findProposal = async (a: App, u: string, id: string) => (await findHeld(a, u, id)).proposal;
  const receiptOf = async (commandId: string | null) => (commandId ? await app.service.getReceipt(principal, commandId) : null);

  if (proposal.state === "confirmed" || proposal.state === "rejected") {
    const same = (proposal.state === "confirmed") === (decision === "confirm");
    if (!same) throw new ApiException("precondition_failed", `this proposal was already ${proposal.state}`, { state: proposal.state });
    return { proposal, receipt: await receiptOf(proposal.commandId), replayed: true };
  }
  if (proposal.state === "expired" && decision === "confirm") throw new ApiException("precondition_failed", "this proposal is too old to confirm; ask for the change again", { state: "expired", expiresAt: proposal.expiresAt });
  // What could not be shown in full is never carried out on a confirmation; it can only be rejected.
  if (!showable && decision === "confirm") throw new ApiException("precondition_failed", "this request cannot be shown in full, so it cannot be confirmed; reject it and ask for the change again in a shorter form", { reason: "not_shown_in_full" });

  const now = toInstant(app.now());
  if (decision === "reject") {
    await prepare(app.db, stmt("INSERT INTO proposal_decisions (user_id, proposal_id, turn_id, command_type, decision, command_id, decided_at, channel) VALUES (?, ?, ?, ?, 'rejected', NULL, ?, ?) ON CONFLICT (user_id, proposal_id) DO NOTHING", userId, proposalId, decisionRef, proposal.type, now, principal.channel)).run();
    return { proposal: await findProposal(app, userId, proposalId), receipt: null, replayed: false };
  }

  // Refused by the command itself (the garment is gone, the state changed since the proposal was made):
  // the error propagates, nothing was written and the proposal is still open.
  const receipt = await app.service.execute(principal, {
    type: proposal.type,
    payload: proposal.payload,
    // One execution per proposal, however often the confirmation is sent.
    idempotencyKey: `proposal:${proposalId}`,
    // The versions the request was made against: a proposal that has gone stale is refused, not applied.
    expectedVersions,
    ...(occurredAt ? { occurredAt } : {}),
    authorization: "owner_tap",
    // The change traces back to the turn that proposed it, when there was one.
    source: proposal.turnId ? { channel: principal.channel, parentKind: "turn", parentId: proposal.turnId } : { channel: principal.channel },
  });
  // A rejection that arrived while the command ran does not hide a change that was made.
  await prepare(
    app.db,
    stmt(
      "INSERT INTO proposal_decisions (user_id, proposal_id, turn_id, command_type, decision, command_id, decided_at, channel) VALUES (?, ?, ?, ?, 'confirmed', ?, ?, ?) ON CONFLICT (user_id, proposal_id) DO UPDATE SET decision = 'confirmed', command_id = excluded.command_id, decided_at = excluded.decided_at, channel = excluded.channel",
      userId, proposalId, decisionRef, proposal.type, receipt.commandId, now, principal.channel,
    ),
  ).run();
  return { proposal: await findProposal(app, userId, proposalId), receipt, replayed: receipt.replayed === true };
}

/** How many proposals wait for the owner (for the recovery and Today surfaces). */
export async function pendingProposalCount(app: App, principal: Principal): Promise<number> {
  const waiting = (await first(app.db, "SELECT 1 AS x FROM assistant_turns WHERE user_id = ? AND proposals_json != '[]' LIMIT 1", principal.userId)) ?? (await first(app.db, "SELECT 1 AS x FROM submitted_proposals WHERE user_id = ? LIMIT 1", principal.userId));
  if (!waiting) return 0;
  return (await listProposals(app, principal)).length;
}
