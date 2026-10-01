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
 * The proposals themselves are read from the assistant's turn records (its `proposals_json`); nothing
 * is copied. Only the decision is stored here (`proposal_decisions`).
 */
import type { CommandReceipt } from "@garderobe/contracts";
import { all, first, json as parseJson, prepare, stmt, toInstant, type Principal } from "@garderobe/domain";
import type { App } from "../app.ts";
import { sha256Hex } from "../crypto.ts";
import { ApiException } from "../errors.ts";

/** A proposal nobody decided is offered for this long; after that it can no longer be confirmed. */
export const PROPOSAL_LIFETIME_MS = 14 * 86_400_000;

export interface Proposal {
  proposalId: string;
  /** The turn (and run) that produced it. */
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

async function fromTurns(app: App, userId: string, turns: TurnRow[], nowMs: number): Promise<Proposal[]> {
  if (turns.length === 0) return [];
  const decisions = new Map((await all<DecisionRow>(app.db, "SELECT proposal_id, decision, command_id, decided_at FROM proposal_decisions WHERE user_id = ?", userId)).map((d) => [d.proposal_id, d]));
  const grants = new Map((await all<{ grant_id: string; client_name: string }>(app.db, "SELECT grant_id, client_name FROM mcp_grants WHERE user_id = ?", userId)).map((g) => [g.grant_id, g.client_name]));
  const proposals: Proposal[] = [];
  for (const turn of turns) {
    const assistantName = turn.auth_ref.startsWith("mcp:") ? (grants.get(turn.auth_ref.slice(4)) ?? null) : null;
    const expiresAtMs = Date.parse(turn.created_at) + PROPOSAL_LIFETIME_MS;
    for (const p of parseJson<{ type?: unknown; summary?: unknown; payload?: unknown }[]>(turn.proposals_json, [])) {
      if (typeof p.type !== "string" || !p.payload || typeof p.payload !== "object") continue;
      const proposalId = await proposalIdOf(turn.turn_id, p.type, p.payload);
      const decision = decisions.get(proposalId);
      proposals.push({
        proposalId,
        turnId: turn.turn_id,
        type: p.type,
        summary: typeof p.summary === "string" ? p.summary : p.type,
        payload: p.payload as Record<string, unknown>,
        proposedAt: turn.created_at,
        expiresAt: toInstant(expiresAtMs),
        source: { channel: turn.channel, assistantName },
        state: decision ? decision.decision : nowMs >= expiresAtMs ? "expired" : "pending",
        decidedAt: decision?.decided_at ?? null,
        commandId: decision?.command_id ?? null,
      });
    }
  }
  return proposals;
}

/** The owner's proposals, newest first. `pending` (the default) is what still waits for a decision. */
export async function listProposals(app: App, principal: Principal, opts: { state?: "pending" | "all" } = {}): Promise<Proposal[]> {
  const nowMs = app.now();
  const turns = await all<TurnRow>(app.db, "SELECT turn_id, channel, auth_ref, created_at, proposals_json FROM assistant_turns WHERE user_id = ? AND proposals_json != '[]' ORDER BY created_at DESC, turn_id LIMIT 200", principal.userId);
  const proposals = await fromTurns(app, principal.userId, turns, nowMs);
  return opts.state === "all" ? proposals : proposals.filter((p) => p.state === "pending");
}

async function findProposal(app: App, userId: string, proposalId: string): Promise<Proposal> {
  // The identifier does not name its turn, so the owner's turns that carry proposals are searched (bounded).
  const turns = await all<TurnRow>(app.db, "SELECT turn_id, channel, auth_ref, created_at, proposals_json FROM assistant_turns WHERE user_id = ? AND proposals_json != '[]' ORDER BY created_at DESC, turn_id LIMIT 500", userId);
  const found = (await fromTurns(app, userId, turns, app.now())).find((p) => p.proposalId === proposalId);
  if (!found) throw new ApiException("not_found", "that proposal was not found");
  return found;
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
  const proposal = await findProposal(app, userId, proposalId);
  const receiptOf = async (commandId: string | null) => (commandId ? await app.service.getReceipt(principal, commandId) : null);

  if (proposal.state === "confirmed" || proposal.state === "rejected") {
    const same = (proposal.state === "confirmed") === (decision === "confirm");
    if (!same) throw new ApiException("precondition_failed", `this proposal was already ${proposal.state}`, { state: proposal.state });
    return { proposal, receipt: await receiptOf(proposal.commandId), replayed: true };
  }
  if (proposal.state === "expired" && decision === "confirm") throw new ApiException("precondition_failed", "this proposal is too old to confirm; ask for the change again", { state: "expired", expiresAt: proposal.expiresAt });

  const now = toInstant(app.now());
  if (decision === "reject") {
    await prepare(app.db, stmt("INSERT INTO proposal_decisions (user_id, proposal_id, turn_id, command_type, decision, command_id, decided_at, channel) VALUES (?, ?, ?, ?, 'rejected', NULL, ?, ?) ON CONFLICT (user_id, proposal_id) DO NOTHING", userId, proposalId, proposal.turnId, proposal.type, now, principal.channel)).run();
    return { proposal: await findProposal(app, userId, proposalId), receipt: null, replayed: false };
  }

  // Refused by the command itself (the garment is gone, the state changed): the error propagates,
  // nothing was written and the proposal is still open.
  const receipt = await app.service.execute(principal, {
    type: proposal.type,
    payload: proposal.payload,
    // One execution per proposal, however often the confirmation is sent.
    idempotencyKey: `proposal:${proposalId}`,
    expectedVersions: {},
    authorization: "owner_tap",
    // The change traces back to the turn that proposed it.
    source: { channel: principal.channel, parentKind: "turn", parentId: proposal.turnId },
  });
  // A rejection that arrived while the command ran does not hide a change that was made.
  await prepare(
    app.db,
    stmt(
      "INSERT INTO proposal_decisions (user_id, proposal_id, turn_id, command_type, decision, command_id, decided_at, channel) VALUES (?, ?, ?, ?, 'confirmed', ?, ?, ?) ON CONFLICT (user_id, proposal_id) DO UPDATE SET decision = 'confirmed', command_id = excluded.command_id, decided_at = excluded.decided_at, channel = excluded.channel",
      userId, proposalId, proposal.turnId, proposal.type, receipt.commandId, now, principal.channel,
    ),
  ).run();
  return { proposal: await findProposal(app, userId, proposalId), receipt, replayed: receipt.replayed === true };
}

/** How many proposals wait for the owner (for the recovery and Today surfaces). */
export async function pendingProposalCount(app: App, principal: Principal): Promise<number> {
  if (!(await first(app.db, "SELECT 1 AS x FROM assistant_turns WHERE user_id = ? AND proposals_json != '[]' LIMIT 1", principal.userId))) return 0;
  return (await listProposals(app, principal)).length;
}
