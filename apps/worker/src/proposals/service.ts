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
import { all, first, json as parseJson, prepare, stmt, toInstant, type Principal } from "@garderobe/domain";
import type { App } from "../app.ts";
import { sha256Hex } from "../crypto.ts";
import { ApiException } from "../errors.ts";
import { describeProposedChange, listSubmittedProposals, submittedExpectedVersions, submittedPayload } from "./store.ts";

/** A proposal nobody decided is offered for this long; after that it can no longer be confirmed. */
export const PROPOSAL_LIFETIME_MS = 14 * 86_400_000;

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

const proposalIdOf = async (turnId: string, type: string, payload: unknown): Promise<string> => `prp_${(await sha256Hex(`proposal\u0000${turnId}\u0000${type}\u0000${JSON.stringify(payload)}`)).slice(0, 32)}`;

/** A proposal with what is needed to run it; only the `Proposal` part leaves this module. */
interface Held {
  proposal: Proposal;
  /** What the decision row records as its origin: the turn, or the grant a typed command came from. */
  decisionRef: string;
  expectedVersions: Record<string, number>;
  occurredAt: string | null;
}

async function held(app: App, userId: string, limit: number, nowMs: number): Promise<Held[]> {
  const turns = await all<TurnRow>(app.db, "SELECT turn_id, channel, auth_ref, created_at, proposals_json FROM assistant_turns WHERE user_id = ? AND proposals_json != '[]' ORDER BY created_at DESC, turn_id LIMIT ?", userId, limit);
  const submitted = await listSubmittedProposals(app.db, userId, limit);
  if (turns.length === 0 && submitted.length === 0) return [];
  const decisions = new Map((await all<DecisionRow>(app.db, "SELECT proposal_id, decision, command_id, decided_at FROM proposal_decisions WHERE user_id = ?", userId)).map((d) => [d.proposal_id, d]));
  const grants = new Map((await all<{ grant_id: string; client_name: string }>(app.db, "SELECT grant_id, client_name FROM mcp_grants WHERE user_id = ?", userId)).map((g) => [g.grant_id, g.client_name]));
  const out: Held[] = [];
  const add = (input: { proposalId: string; turnId: string; decisionRef: string; type: string; summary?: string; payload: Record<string, unknown>; proposedAt: string; channel: string; assistantName: string | null; expectedVersions: Record<string, number>; occurredAt: string | null }) => {
    const decision = decisions.get(input.proposalId);
    const expiresAtMs = Date.parse(input.proposedAt) + PROPOSAL_LIFETIME_MS;
    out.push({
      proposal: {
        proposalId: input.proposalId,
        turnId: input.turnId,
        type: input.type,
        // A turn's proposal carries the summary the assistant workstream's trusted code composed; any other
        // proposal gets one written here from the command type and the exact payload.
        summary: input.summary ?? describeProposedChange(input.type, input.payload),
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
    });
  };
  const grantOfTurn = new Map(turns.map((t) => [t.turn_id, t.auth_ref.startsWith("mcp:") ? t.auth_ref.slice(4) : null]));
  for (const turn of turns) {
    const grantId = grantOfTurn.get(turn.turn_id) ?? null;
    for (const p of parseJson<{ type?: unknown; summary?: unknown; payload?: unknown; expectedVersions?: unknown }[]>(turn.proposals_json, [])) {
      if (typeof p.type !== "string" || !p.payload || typeof p.payload !== "object") continue;
      const payload = p.payload as Record<string, unknown>;
      // The versions the proposal was built against, when the assistant recorded them: passed to the command on confirm.
      const expectedVersions = p.expectedVersions && typeof p.expectedVersions === "object" ? Object.fromEntries(Object.entries(p.expectedVersions as Record<string, unknown>).filter((e): e is [string, number] => typeof e[1] === "number")) : {};
      add({ proposalId: await proposalIdOf(turn.turn_id, p.type, payload), turnId: turn.turn_id, decisionRef: turn.turn_id, type: p.type, ...(typeof p.summary === "string" && p.summary ? { summary: p.summary } : {}), payload, proposedAt: turn.created_at, channel: turn.channel, assistantName: grantId ? (grants.get(grantId) ?? null) : null, expectedVersions, occurredAt: null });
    }
  }
  for (const row of submitted) {
    let grantId = row.grant_id;
    if (!grantId && row.turn_id) {
      const authRef = grantOfTurn.has(row.turn_id) ? null : (await first<{ auth_ref: string }>(app.db, "SELECT auth_ref FROM assistant_turns WHERE user_id = ? AND turn_id = ?", userId, row.turn_id))?.auth_ref;
      grantId = grantOfTurn.get(row.turn_id) ?? (authRef?.startsWith("mcp:") ? authRef.slice(4) : null);
    }
    add({ proposalId: row.proposal_id, turnId: row.turn_id ?? "", decisionRef: row.turn_id ?? row.source_ref, type: row.command_type, payload: submittedPayload(row), proposedAt: row.created_at, channel: "mcp", assistantName: grantId ? (grants.get(grantId) ?? null) : null, expectedVersions: submittedExpectedVersions(row), occurredAt: row.occurred_at });
  }
  return out.sort((a, b) => (a.proposal.proposedAt < b.proposal.proposedAt ? 1 : a.proposal.proposedAt > b.proposal.proposedAt ? -1 : a.proposal.proposalId < b.proposal.proposalId ? -1 : 1));
}

/** The owner's proposals, newest first. `pending` (the default) is what still waits for a decision. */
export async function listProposals(app: App, principal: Principal, opts: { state?: "pending" | "all" } = {}): Promise<Proposal[]> {
  const proposals = (await held(app, principal.userId, 200, app.now())).map((h) => h.proposal);
  return opts.state === "all" ? proposals : proposals.filter((p) => p.state === "pending");
}

async function findHeld(app: App, userId: string, proposalId: string): Promise<Held> {
  // The identifier does not name its origin, so the owner's proposals are searched (bounded).
  const found = (await held(app, userId, 500, app.now())).find((h) => h.proposal.proposalId === proposalId);
  if (!found) throw new ApiException("not_found", "that proposal was not found");
  return found;
}

/** The state of one proposal by identifier, for the connection that submitted it (no content is returned). */
export async function submittedProposalState(app: App, userId: string, proposalId: string): Promise<{ state: Proposal["state"]; commandId: string | null }> {
  const { proposal } = await findHeld(app, userId, proposalId);
  return { state: proposal.state, commandId: proposal.commandId };
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
  const { proposal, decisionRef, expectedVersions, occurredAt } = await findHeld(app, userId, proposalId);
  const findProposal = async (a: App, u: string, id: string) => (await findHeld(a, u, id)).proposal;
  const receiptOf = async (commandId: string | null) => (commandId ? await app.service.getReceipt(principal, commandId) : null);

  if (proposal.state === "confirmed" || proposal.state === "rejected") {
    const same = (proposal.state === "confirmed") === (decision === "confirm");
    if (!same) throw new ApiException("precondition_failed", `this proposal was already ${proposal.state}`, { state: proposal.state });
    return { proposal, receipt: await receiptOf(proposal.commandId), replayed: true };
  }
  if (proposal.state === "expired" && decision === "confirm") throw new ApiException("precondition_failed", "this proposal is too old to confirm; ask for the change again", { state: "expired", expiresAt: proposal.expiresAt });

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
