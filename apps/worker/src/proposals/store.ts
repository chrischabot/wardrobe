/**
 * Proposals that do not come from an assistant turn's own record: a sensitive typed command sent by a
 * connected assistant, and a command Garderobe's assistant tried on relayed text that is not allowed
 * there. This module only stores and reads them (table `submitted_proposals`); deciding them is in
 * `service.ts`. It has no dependency on the composed application, so the command registry guards can
 * use it.
 */
import { describeChange, expectedVersionsFor, MAX_PROPOSALS_PER_TURN, MAX_SHOWN_VALUE, MAX_SUMMARY } from "@garderobe/assistant";
import { CommandError, all, canonicalJson, first, isCommandError, json as parseJson, prepare, stmt, toInstant, type Db } from "@garderobe/domain";
import { sha256Hex } from "../crypto.ts";

export type SubmittedOrigin = "typed_command" | "relayed_turn";

export interface SubmittedProposalInput {
  userId: string;
  origin: SubmittedOrigin;
  /** The grant (typed_command) or the turn (relayed_turn). */
  sourceRef: string;
  grantId: string | null;
  turnId: string | null;
  idempotencyKey: string;
  type: string;
  payload: Record<string, unknown>;
  expectedVersions: Record<string, number>;
  occurredAt: string | null;
  nowMs: number;
}

export interface SubmittedProposalRow {
  proposal_id: string;
  origin: SubmittedOrigin;
  source_ref: string;
  grant_id: string | null;
  turn_id: string | null;
  idempotency_key: string;
  request_hash: string;
  command_type: string;
  payload_json: string;
  expected_versions_json: string;
  occurred_at: string | null;
  created_at: string;
}

const COLUMNS = "proposal_id, origin, source_ref, grant_id, turn_id, idempotency_key, request_hash, command_type, payload_json, expected_versions_json, occurred_at, created_at";

/** Everything that defines the change. A request that differs in any of it is a different proposal. */
export const requestHashOf = (input: Pick<SubmittedProposalInput, "type" | "payload" | "expectedVersions" | "occurredAt">): Promise<string> =>
  sha256Hex(canonicalJson({ type: input.type, payload: input.payload, expectedVersions: input.expectedVersions, occurredAt: input.occurredAt }));

/** The deterministic proposal identifier covering origin, source, idempotency key, and the effective request digest. */
export const submittedProposalIdOf = async (input: Pick<SubmittedProposalInput, "origin" | "sourceRef" | "idempotencyKey" | "type" | "payload" | "expectedVersions" | "occurredAt">): Promise<string> => {
  const effectiveHash = await requestHashOf(input);
  return `prp_${(await sha256Hex(`submitted\u0000${input.origin}\u0000${input.sourceRef}\u0000${input.idempotencyKey}\u0000${effectiveHash}`)).slice(0, 32)}`;
};

/** A proposal nobody decided is offered for this long; after that it can no longer be confirmed and no longer counts as waiting. */
export const PROPOSAL_LIFETIME_MS = 14 * 86_400_000;

/**
 * Lease duration for an unpersisted relayed-turn admission (before `assistant_turns` records the turn).
 * Active callers renew their row while in flight; an orphaned row from a terminated worker expires after
 * this window and is reconciled on subsequent reads/admissions instead of stranding quota for 14 days.
 */
export const ADMISSION_LEASE_MS = 60_000;
const ADMISSION_LEASE_OFFSET_SECONDS = Math.floor((PROPOSAL_LIFETIME_MS - ADMISSION_LEASE_MS) / 1000);

/**
 * How many requests connected assistants may have waiting for the owner at once. A request counts from
 * the moment it is kept until the owner decides it or it expires, wherever it is kept: a typed command, a
 * command refused on a relayed turn (both in `submitted_proposals`), and what the assistant recorded on a
 * turn a connection started (`assistant_turns.proposals_json`). The limits protect the owner's list, and
 * only the owner can take something off it, so opening a second connection or asking through
 * `garderobe_ask` instead of a typed command gives no further room.
 */
export const WAITING_LIMITS = { perConnection: 40, perOwner: 80, perRelayedTurn: MAX_PROPOSALS_PER_TURN } as const;

export interface WaitingRequests {
  /** Everything connected assistants have waiting for this owner, including unconsumed slots of unfinished relayed turns. */
  total: number;
  byGrant: Map<string, number>;
  byTurn: Map<string, number>;
  reservedByTurn: Map<string, number>;
}

/**
 * Shared SQL CTE computing the owner's and the connection's current waiting + reserved request counts in a
 * single statement snapshot (`?1` = userId, `?2` = sinceSeconds, `?3` = grantId, `?4` = perRelayedTurn).
 */
const WAITING_COUNTS_CTE = `
WITH same_client_grants AS (
  SELECT ?3 AS grant_id WHERE ?3 IS NOT NULL
  UNION
  SELECT g2.grant_id
    FROM mcp_grants g1
    JOIN mcp_grants g2 ON g2.user_id = g1.user_id AND g2.client_id = g1.client_id
   WHERE g1.user_id = ?1 AND g1.grant_id = ?3
),
undecided_submitted AS (
  SELECT COALESCE(p.grant_id, CASE WHEN t.auth_ref LIKE 'mcp:%' THEN substr(t.auth_ref, 5) END) AS grant_id,
         p.turn_id AS turn_id,
         COUNT(*) AS n
    FROM submitted_proposals p
    LEFT JOIN assistant_turns t ON t.user_id = p.user_id AND t.turn_id = p.turn_id
   WHERE p.user_id = ?1 AND unixepoch(p.created_at) > ?2
     AND NOT EXISTS (SELECT 1 FROM proposal_decisions d WHERE d.user_id = p.user_id AND d.proposal_id = p.proposal_id)
   GROUP BY 1, 2
),
turn_usage AS (
  SELECT substr(t.auth_ref, 5) AS grant_id,
         t.turn_id AS turn_id,
         MAX(0, json_array_length(t.proposals_json) - (
           SELECT COUNT(*) FROM proposal_decisions d
            WHERE d.user_id = t.user_id AND d.turn_id = t.turn_id
              AND NOT EXISTS (SELECT 1 FROM submitted_proposals s WHERE s.user_id = d.user_id AND s.proposal_id = d.proposal_id)
         )) AS recorded,
         COALESCE((SELECT SUM(u.n) FROM undecided_submitted u WHERE u.turn_id = t.turn_id), 0) AS submitted_n,
         CASE WHEN t.kind = 'conversation' AND t.status NOT IN ('completed', 'failed', 'cancelled') THEN 1 ELSE 0 END AS active_conv
    FROM assistant_turns t
   WHERE t.user_id = ?1 AND t.auth_ref LIKE 'mcp:%' AND unixepoch(t.created_at) > ?2
     AND (t.proposals_json != '[]' OR (t.kind = 'conversation' AND t.status NOT IN ('completed', 'failed', 'cancelled')))
),
unpersisted_admissions AS (
  SELECT a.grant_id AS grant_id, a.submission_id AS submission_id
    FROM relayed_turn_admissions a
   WHERE a.user_id = ?1 AND unixepoch(a.created_at) > (?2 + ${ADMISSION_LEASE_OFFSET_SECONDS})
     AND NOT EXISTS (SELECT 1 FROM assistant_turns t WHERE t.user_id = a.user_id AND t.submission_id = a.submission_id)
   GROUP BY a.grant_id, a.submission_id
),
all_entries AS (
  SELECT grant_id, n AS count FROM undecided_submitted
  UNION ALL
  SELECT grant_id,
         recorded + CASE WHEN active_conv = 1 THEN MAX(0, ?4 - (submitted_n + recorded)) ELSE 0 END AS count
    FROM turn_usage
  UNION ALL
  SELECT grant_id, ?4 AS count FROM unpersisted_admissions
),
totals AS (
  SELECT COALESCE(SUM(count), 0) AS owner_total,
         COALESCE(SUM(CASE WHEN grant_id IN (SELECT grant_id FROM same_client_grants) THEN count ELSE 0 END), 0) AS grant_total
    FROM all_entries
)`;

/** Reconcile expired or already-persisted relayed-turn admissions so orphaned rows from terminated workers do not linger in D1. */
export async function reconcileRelayedTurnAdmissions(db: Db, userId: string, nowMs: number): Promise<void> {
  const leaseSinceSeconds = Math.floor((nowMs - ADMISSION_LEASE_MS) / 1000);
  await prepare(
    db,
    stmt(
      `DELETE FROM relayed_turn_admissions
        WHERE user_id = ?
          AND (unixepoch(created_at) <= ?
               OR EXISTS (SELECT 1 FROM assistant_turns t WHERE t.user_id = relayed_turn_admissions.user_id AND t.submission_id = relayed_turn_admissions.submission_id))`,
      userId,
      leaseSinceSeconds,
    ),
  ).run();
}

/** What connected assistants have waiting for the owner's decision right now, per connection (grant) and in all. */
export async function waitingRequests(db: Db, userId: string, nowMs: number): Promise<WaitingRequests> {
  await reconcileRelayedTurnAdmissions(db, userId, nowMs);
  const sinceSeconds = Math.floor((nowMs - PROPOSAL_LIFETIME_MS) / 1000);
  const out: WaitingRequests = { total: 0, byGrant: new Map(), byTurn: new Map(), reservedByTurn: new Map() };
  // Read grants, undecided submitted proposals, assistant turns, and unpersisted turn admissions in a single
  // SQL statement so a turn transitioning from admission to assistant_turns is never missed or double-counted.
  const rows = await all<{
    kind: "grant" | "submitted" | "turn" | "admission";
    grant_id: string | null;
    client_id: string | null;
    turn_id: string | null;
    n: number;
    reserved: number;
  }>(
    db,
    `SELECT 'grant' AS kind, g.grant_id AS grant_id, g.client_id AS client_id, NULL AS turn_id, 0 AS n, 0 AS reserved
       FROM mcp_grants g
      WHERE g.user_id = ?1
     UNION ALL
     SELECT 'submitted' AS kind,
            COALESCE(p.grant_id, CASE WHEN t.auth_ref LIKE 'mcp:%' THEN substr(t.auth_ref, 5) END) AS grant_id,
            NULL AS client_id,
            p.turn_id AS turn_id,
            COUNT(*) AS n,
            0 AS reserved
       FROM submitted_proposals p
       LEFT JOIN assistant_turns t ON t.user_id = p.user_id AND t.turn_id = p.turn_id
      WHERE p.user_id = ?1 AND unixepoch(p.created_at) > ?2
        AND NOT EXISTS (SELECT 1 FROM proposal_decisions d WHERE d.user_id = p.user_id AND d.proposal_id = p.proposal_id)
      GROUP BY 2, 4
     UNION ALL
     SELECT 'turn' AS kind,
            substr(t.auth_ref, 5) AS grant_id,
            NULL AS client_id,
            t.turn_id AS turn_id,
            MAX(0, json_array_length(t.proposals_json) - (
              SELECT COUNT(*) FROM proposal_decisions d
               WHERE d.user_id = t.user_id AND d.turn_id = t.turn_id
                 AND NOT EXISTS (SELECT 1 FROM submitted_proposals s WHERE s.user_id = d.user_id AND s.proposal_id = d.proposal_id)
            )) AS n,
            CASE WHEN t.kind = 'conversation' AND t.status NOT IN ('completed', 'failed', 'cancelled') THEN 1 ELSE 0 END AS reserved
       FROM assistant_turns t
      WHERE t.user_id = ?1 AND t.auth_ref LIKE 'mcp:%' AND unixepoch(t.created_at) > ?2
        AND (t.proposals_json != '[]' OR (t.kind = 'conversation' AND t.status NOT IN ('completed', 'failed', 'cancelled')))
     UNION ALL
     SELECT 'admission' AS kind,
            a.grant_id AS grant_id,
            NULL AS client_id,
            NULL AS turn_id,
            0 AS n,
            1 AS reserved
       FROM relayed_turn_admissions a
      WHERE a.user_id = ?1 AND unixepoch(a.created_at) > (?2 + ${ADMISSION_LEASE_OFFSET_SECONDS})
        AND NOT EXISTS (SELECT 1 FROM assistant_turns t WHERE t.user_id = a.user_id AND t.submission_id = a.submission_id)
      GROUP BY a.grant_id, a.submission_id`,
    userId,
    sinceSeconds,
  );
  const grants: { grant_id: string; client_id: string }[] = [];
  const clientOfGrant = new Map<string, string>();
  for (const row of rows) {
    if (row.kind === "grant" && row.grant_id && row.client_id) {
      grants.push({ grant_id: row.grant_id, client_id: row.client_id });
      clientOfGrant.set(row.grant_id, row.client_id);
    }
  }
  const byClient = new Map<string, number>();
  const add = (grant: string | null, n: number) => {
    if (n <= 0) return;
    out.total += n;
    if (grant) {
      out.byGrant.set(grant, (out.byGrant.get(grant) ?? 0) + n);
      const clientId = clientOfGrant.get(grant);
      if (clientId) byClient.set(clientId, (byClient.get(clientId) ?? 0) + n);
    }
  };
  for (const row of rows) {
    if (row.kind !== "submitted") continue;
    add(row.grant_id, row.n);
    if (row.turn_id) out.byTurn.set(row.turn_id, (out.byTurn.get(row.turn_id) ?? 0) + row.n);
  }
  for (const row of rows) {
    if (row.kind !== "turn") continue;
    const recorded = Math.max(0, row.n);
    if (recorded > 0 && row.turn_id) out.byTurn.set(row.turn_id, (out.byTurn.get(row.turn_id) ?? 0) + recorded);
    const unconsumed = row.reserved === 1 && row.turn_id ? Math.max(0, WAITING_LIMITS.perRelayedTurn - (out.byTurn.get(row.turn_id) ?? 0)) : 0;
    if (unconsumed > 0 && row.turn_id) out.reservedByTurn.set(row.turn_id, unconsumed);
    add(row.grant_id, recorded + unconsumed);
  }
  for (const row of rows) {
    if (row.kind !== "admission") continue;
    add(row.grant_id, WAITING_LIMITS.perRelayedTurn);
  }
  // All grants of the same registered OAuth client share its 40-request allowance, so re-approving the same
  // client gives it no second quota of waiting requests.
  for (const { grant_id, client_id } of grants) {
    const clientTotal = byClient.get(client_id) ?? 0;
    if (clientTotal > 0) out.byGrant.set(grant_id, clientTotal);
  }
  return out;
}

export interface RelayedTurnAdmission {
  ok: boolean;
  isActive: () => boolean;
  /** Renew and verify the admission lease right before dispatching to the assistant. */
  ensureActive: () => Promise<boolean>;
  release: () => Promise<void>;
}

/**
 * Atomically check and reserve per-turn proposal capacity (`WAITING_LIMITS.perRelayedTurn`) in D1 for a
 * relayed `garderobe_ask` turn before dispatching to the assistant. Each call inserts its own `admission_id`
 * row under a 60-second lease (`ADMISSION_LEASE_MS`) renewed while in flight; a `BEFORE INSERT` trigger on
 * `assistant_turns` (`0310_api_relayed_turn_admission_lease.sql`) refuses to persist a new relayed MCP
 * conversation turn if its admission lease has expired or been reconciled away.
 */
export async function beginRelayedTurn(
  db: Db,
  userId: string,
  submissionId: string,
  grantId: string,
  nowMs: number,
): Promise<RelayedTurnAdmission> {
  const startWallMs = Date.now();
  const clockMs = () => nowMs + Math.max(0, Date.now() - startWallMs);
  await reconcileRelayedTurnAdmissions(db, userId, clockMs());
  const existingTurn = await first<{ x: number }>(db, "SELECT 1 AS x FROM assistant_turns WHERE user_id = ? AND submission_id = ?", userId, submissionId);
  if (existingTurn) {
    return {
      ok: true,
      isActive: () => true,
      ensureActive: async () => true,
      release: async () => {},
    };
  }
  const insertNowMs = clockMs();
  const sinceSeconds = Math.floor((insertNowMs - PROPOSAL_LIFETIME_MS) / 1000);
  const admissionId = crypto.randomUUID();
  const res = await prepare(
    db,
    stmt(
      `${WAITING_COUNTS_CTE}
       INSERT INTO relayed_turn_admissions (user_id, submission_id, admission_id, grant_id, created_at)
       SELECT ?1, ?5, ?6, ?3, ?7
         FROM totals
        WHERE EXISTS (SELECT 1 FROM assistant_turns t WHERE t.user_id = ?1 AND t.submission_id = ?5)
           OR EXISTS (SELECT 1 FROM relayed_turn_admissions a WHERE a.user_id = ?1 AND a.submission_id = ?5 AND unixepoch(a.created_at) > (?2 + ${ADMISSION_LEASE_OFFSET_SECONDS}))
           OR (totals.owner_total + ?4 <= ?8 AND (?3 IS NULL OR totals.grant_total + ?4 <= ?9))`,
      userId,
      sinceSeconds,
      grantId,
      WAITING_LIMITS.perRelayedTurn,
      submissionId,
      admissionId,
      toInstant(insertNowMs),
      WAITING_LIMITS.perOwner,
      WAITING_LIMITS.perConnection,
    ),
  ).run();
  if ((res.meta?.changes ?? 0) === 0) {
    return {
      ok: false,
      isActive: () => false,
      ensureActive: async () => false,
      release: async () => {},
    };
  }
  let stopped = false;
  let leaseLost = false;
  let renewInFlight: Promise<void> | null = null;
  const markLost = () => {
    if (leaseLost) return;
    leaseLost = true;
    stopped = true;
    clearInterval(heartbeat);
  };
  const renewOnce = async (): Promise<boolean> => {
    if (leaseLost) return false;
    const t = clockMs();
    try {
      const updateRes = await prepare(
        db,
        stmt(
          "UPDATE relayed_turn_admissions SET created_at = CASE WHEN unixepoch(?) >= unixepoch('now') THEN ? ELSE strftime('%Y-%m-%dT%H:%M:%SZ', 'now') END WHERE user_id = ? AND submission_id = ? AND admission_id = ? AND unixepoch(created_at) > ? AND unixepoch(created_at) + 60 > unixepoch('now')",
          toInstant(t),
          toInstant(t),
          userId,
          submissionId,
          admissionId,
          Math.floor((t - ADMISSION_LEASE_MS) / 1000),
        ),
      ).run();
      if ((updateRes.meta?.changes ?? 0) === 1) return true;
      const persisted = await first<{ x: number }>(db, "SELECT 1 AS x FROM assistant_turns WHERE user_id = ? AND submission_id = ?", userId, submissionId);
      if (persisted) {
        stopped = true;
        clearInterval(heartbeat);
        return true;
      }
      markLost();
      return false;
    } catch (err) {
      console.warn("relayed turn admission lease renewal failed", String((err as Error)?.message ?? err));
      markLost();
      return false;
    }
  };
  const heartbeat = setInterval(() => {
    if (stopped || leaseLost || renewInFlight) return;
    renewInFlight = renewOnce()
      .then(() => {})
      .finally(() => {
        renewInFlight = null;
      });
  }, Math.floor(ADMISSION_LEASE_MS / 3));
  return {
    ok: true,
    isActive: () => !leaseLost,
    ensureActive: async () => {
      if (renewInFlight) await renewInFlight;
      return renewOnce();
    },
    release: async () => {
      stopped = true;
      clearInterval(heartbeat);
      if (renewInFlight) await renewInFlight;
      const deleteStmt = stmt(
        `DELETE FROM relayed_turn_admissions
          WHERE user_id = ?
            AND ((submission_id = ? AND admission_id = ?)
                 OR unixepoch(created_at) <= ?
                 OR EXISTS (SELECT 1 FROM assistant_turns t WHERE t.user_id = relayed_turn_admissions.user_id AND t.submission_id = relayed_turn_admissions.submission_id))`,
        userId,
        submissionId,
        admissionId,
        Math.floor((clockMs() - ADMISSION_LEASE_MS) / 1000),
      );
      try {
        await prepare(db, deleteStmt).run();
      } catch {
        try {
          await prepare(db, deleteStmt).run();
        } catch (retryError) {
          console.warn("relayed turn admission cleanup failed after retry", String((retryError as Error)?.message ?? retryError));
        }
      }
    },
  };
}

/** Whether a connection may leave one more request for the owner: neither it nor all connections together are at their limit. */
export function hasRoomToWait(waiting: WaitingRequests, grantId: string | null): boolean {
  return hasRoomFor(waiting, grantId, 1);
}

/**
 * Whether `count` more requests fit: within the owner's limit and the connection's. A relayed turn asks for
 * room for everything one turn can leave (the assistant's per-turn bound), checked before the turn starts,
 * because what the assistant records on the turn is not checked request by request (adversarial defect M14-7).
 */
export function hasRoomFor(waiting: WaitingRequests, grantId: string | null, count: number): boolean {
  if (waiting.total + count > WAITING_LIMITS.perOwner) return false;
  return !grantId || (waiting.byGrant.get(grantId) ?? 0) + count <= WAITING_LIMITS.perConnection;
}

/**
 * Keep one request as a proposal. Repeating the same request (same origin, source and idempotency key)
 * returns the proposal already kept; the same key with a different request returns `conflict`, and
 * nothing is stored for it. When the connection, all connections together or the relayed turn already
 * have their share of requests waiting, the answer is `limited`: the owner's list is not something a
 * connected assistant can fill up. A request whose summary could not be shown to the owner in full is
 * `unshowable` and is not kept: the owner never confirms text they were not shown.
 */
export async function recordSubmittedProposal(db: Db, input: SubmittedProposalInput): Promise<{ row: SubmittedProposalRow; created: boolean } | { conflict: true } | { limited: true } | { unshowable: true }> {
  const requestHash = await requestHashOf(input);
  const find = () => first<SubmittedProposalRow>(db, `SELECT ${COLUMNS} FROM submitted_proposals WHERE user_id = ? AND origin = ? AND source_ref = ? AND idempotency_key = ?`, input.userId, input.origin, input.sourceRef, input.idempotencyKey);
  const existing = await find();
  if (existing) return existing.request_hash === requestHash ? { row: existing, created: false } : { conflict: true };
  if (!(await canBeShownInFull(db, input.userId, input.type, input.payload))) return { unshowable: true };
  // Capture the current versions of records the request would rewrite when the caller did not specify them,
  // so a request whose target changed before the owner confirms is refused as stale (409 conflict).
  const capturedVersions = await expectedVersionsFor(db, input.userId, input.type, input.payload);
  const effectiveVersions = { ...capturedVersions, ...input.expectedVersions };
  const proposalId = await submittedProposalIdOf({ ...input, expectedVersions: effectiveVersions });
  // The connection a relayed turn belongs to is read from the turn; a typed command names its grant.
  const grantId = input.grantId ?? (input.turnId ? grantOfAuthRef((await first<{ auth_ref: string }>(db, "SELECT auth_ref FROM assistant_turns WHERE user_id = ? AND turn_id = ?", input.userId, input.turnId))?.auth_ref) : null);
  await reconcileRelayedTurnAdmissions(db, input.userId, input.nowMs);
  const sinceSeconds = Math.floor((input.nowMs - PROPOSAL_LIFETIME_MS) / 1000);
  const res = await prepare(
    db,
    stmt(
      `${WAITING_COUNTS_CTE}
       INSERT INTO submitted_proposals (user_id, proposal_id, origin, source_ref, grant_id, turn_id, idempotency_key, request_hash, command_type, payload_json, expected_versions_json, occurred_at, created_at)
       SELECT ?1, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18
         FROM totals
        WHERE (?8 != 'relayed_turn' OR (
                COALESCE((SELECT SUM(u.n) FROM undecided_submitted u WHERE u.turn_id = ?9), 0)
                + COALESCE((SELECT SUM(tu.recorded) FROM turn_usage tu WHERE tu.turn_id = ?9), 0)
              ) < ?4)
          AND (totals.owner_total + CASE
                WHEN ?8 = 'relayed_turn' AND ?11 IS NOT NULL AND EXISTS (
                  SELECT 1 FROM turn_usage tu WHERE tu.turn_id = ?11 AND tu.active_conv = 1 AND (tu.submitted_n + tu.recorded) < ?4
                ) THEN 0
                ELSE 1
              END) <= ?5
          AND (?3 IS NULL OR (totals.grant_total + CASE
                WHEN ?8 = 'relayed_turn' AND ?11 IS NOT NULL AND EXISTS (
                  SELECT 1 FROM turn_usage tu WHERE tu.turn_id = ?11 AND tu.active_conv = 1 AND (tu.submitted_n + tu.recorded) < ?4
                ) THEN 0
                ELSE 1
              END) <= ?6)
       ON CONFLICT DO NOTHING`,
      input.userId,
      sinceSeconds,
      grantId,
      WAITING_LIMITS.perRelayedTurn,
      WAITING_LIMITS.perOwner,
      WAITING_LIMITS.perConnection,
      proposalId,
      input.origin,
      input.sourceRef,
      input.grantId,
      input.turnId,
      input.idempotencyKey,
      requestHash,
      input.type,
      JSON.stringify(input.payload),
      JSON.stringify(effectiveVersions),
      input.occurredAt,
      toInstant(input.nowMs),
    ),
  ).run();
  const inserted = (res.meta?.changes ?? 0) > 0;
  const row = await find();
  if (!row) return { limited: true };
  return row.request_hash === requestHash ? { row, created: inserted } : { conflict: true };
}

/** The grant a turn was started under, when a connected assistant started it. */
export const grantOfAuthRef = (authRef: string | null | undefined): string | null => (authRef?.startsWith("mcp:") ? authRef.slice(4) : null);

/** The newest kept requests, decided or not: the history part of the owner's list. */
export const listSubmittedProposals = (db: Db, userId: string, limit: number): Promise<SubmittedProposalRow[]> =>
  all<SubmittedProposalRow>(db, `SELECT ${COLUMNS} FROM submitted_proposals WHERE user_id = ? ORDER BY unixepoch(created_at) DESC, proposal_id LIMIT ?`, userId, limit);

/** Every kept request the owner has not decided and that has not expired. Not truncated: nothing waiting is left off the owner's list. */
export const listWaitingSubmittedProposals = (db: Db, userId: string, nowMs: number): Promise<SubmittedProposalRow[]> =>
  all<SubmittedProposalRow>(
    db,
    `SELECT ${COLUMNS} FROM submitted_proposals p WHERE p.user_id = ? AND unixepoch(p.created_at) > ?
        AND NOT EXISTS (SELECT 1 FROM proposal_decisions d WHERE d.user_id = p.user_id AND d.proposal_id = p.proposal_id)`,
    userId, Math.floor((nowMs - PROPOSAL_LIFETIME_MS) / 1000),
  );

export const findSubmittedProposal = (db: Db, userId: string, proposalId: string): Promise<SubmittedProposalRow | null> =>
  first<SubmittedProposalRow>(db, `SELECT ${COLUMNS} FROM submitted_proposals WHERE user_id = ? AND proposal_id = ?`, userId, proposalId);

export const submittedPayload = (row: SubmittedProposalRow): Record<string, unknown> => parseJson<Record<string, unknown>>(row.payload_json, {});
export const submittedExpectedVersions = (row: SubmittedProposalRow): Record<string, number> => parseJson<Record<string, number>>(row.expected_versions_json, {});

/** The plain label of each command type a request can be kept for: how a change is named to the owner when it has no sentence of its own. */
export const LABELS: Record<string, string> = {
  "garment.create": "Add a garment to the wardrobe",
  "garment.receive": "Mark an incoming garment as arrived and owned",
  "garment.retire": "Retire a garment from the wardrobe",
  "garment.merge": "Merge two garment records into one",
  "garment.remove_fabricated": "Remove a garment record as a mistake",
  "garment.bulk_correct": "Correct several garments at once",
  "garment.correct": "Correct a garment's details",
  "garment.add_alias": "Add another name for a garment",
  "garment.move": "Record where a garment is",
  "stock.reconcile": "Set the counted quantities of a garment",
  "style.add_amendment": "Add an amendment to My style",
  "style.set_amendment_status": "Change the status of an amendment to My style",
  "style.save_document": "Save a new version of My style",
  "style.import_document": "Replace My style with an imported document",
  "style.upsert_rule": "Add or change a style rule",
  "style.add_direction": "Add a standing direction",
  "style.retire_direction": "Retire a standing direction",
  "style.resolve_fact_conflict": "Decide a conflict between My style and a stored fact",
  "style.set_brief": "Set the brief for a day",
  "style.retire_brief": "Withdraw the brief for a day",
  "garment.remove_alias": "Remove a name for a garment",
  "garment.set_planning_policy": "Change whether a garment is offered in outfits",
  "stock.pack": "Record garments as packed for a trip",
  "stock.unpack": "Record garments as unpacked after a trip",
  "size_experience.record": "Record how a size fits",
  "laundry.collect": "Record a laundry pickup",
  "laundry.return": "Record that laundry came back",
  "laundry.report_exception": "Record that laundry did not come back as expected",
  "board.select": "Choose an outfit on a day's board",
  "board.swap_slot": "Swap one piece of an outfit on a day's board",
  "board.suppress": "Stop showing a day's board",
  "board.restore": "Bring back a day's board",
  "exposure.select": "Record which offered option was chosen",
  "feedback.record": "Record feedback on an outfit or a garment",
  "feedback.retract": "Withdraw recorded feedback",
  "service.pause": "Pause the daily service",
  "service.resume": "Resume the daily service",
  "settings.update": "Change settings",
  "trip.create": "Add a trip",
  "trip.update": "Change a trip",
  "trip.cancel": "Cancel a trip",
  "studio.save_combination": "Save a combination in Studio",
  "studio.remove_combination": "Remove a saved combination",
  "studio.plan_for_day": "Plan a combination for a day",
  "studio.remove_day_plan": "Remove a day's plan",
  "reminder.set": "Set a reminder",
  "reminder.cancel": "Cancel a reminder",
  "memory.record_conclusion": "Remember something about you",
  "memory.set_status": "Change what is remembered about you",
  "purchase.import_order": "Record an order",
  "purchase.link_line": "Link an order line to a garment",
  "purchase.record_event": "Record an event on an order",
  "purchase.mark_delivered": "Mark an order as delivered",
  "return.open_case": "Open a return or exchange",
  "return.update_case": "Change a return or exchange",
  "return.link_exchange": "Link an exchange to its replacement",
  "lifecycle.open_project": "Open a repair or alteration project",
  "lifecycle.update_project": "Change a repair or alteration project",
  "lifecycle.record_event": "Record an event on a repair or alteration project",
  "connection.register": "Add a connection to another service",
  "connection.set_status": "Enable or disable a connection to another service",
  "connection.set_tool_groups": "Change what a connected service may be used for",
  "inference.set_routing": "Change which model answers",
  "media.authorize_upload": "Prepare an image upload",
  "media.finalize_upload": "Finish an image upload",
  "media.decide_review": "Decide an image waiting for review",
  "media.set_primary_asset": "Choose a garment's main image",
  "media.request_discovery": "Search for product images",
  "media.request_composite_preview": "Render an outfit preview",
  "job.create": "Start a background job",
  "measurement.record": "Record a measurement",
  "restriction.add": "Record a restriction",
  "restriction.resolve": "Lift a restriction",
  "conversation.forget_source": "Forget something you said or sent",
  "media.delete_asset": "Delete an image",
  "lifecycle.authorize_action": "Authorize an action with another party",
  "command.undo": "Undo an earlier change",
  "wear.record": "Record a wear",
  "wear.amend": "Change a recorded wear",
};

/** The longest summary the owner is asked to read, and the longest single value in it. A request that needs more is refused, never shortened. */
export const MAX_SUMMARY_CHARS = MAX_SUMMARY;
export const MAX_VALUE_CHARS = MAX_SHOWN_VALUE;

/**
 * The summary the owner is shown for a kept request, in words. It is the assistant workstream's
 * `describeChange`, the same trusted code that writes the summary of a request made in conversation, so
 * both paths read alike: the system's own sentence for the change, records named from the ledger (a
 * piece by its name, a trip by its name and dates, a board by its day, an option by its position) instead
 * of identifiers, every other field listed by name with its value in full, and nothing shortened. For a
 * command that has no sentence of its own there, the opening is this module's plain label for the type
 * instead of the command's machine name, and the change an undo would reverse is named by its label
 * rather than by its command name. It is derived from the stored payload each time it is read, so
 * it cannot differ from what would run. Throws `invalid_command` (`summary_too_long`) when the request
 * cannot be shown in full.
 */
export async function describeSubmittedChange(db: Db, userId: string, type: string, payload: Record<string, unknown>): Promise<string> {
  let summary = await describeChange(db, userId, type, payload);
  const machineOpening = `Carry out \u201C${type}\u201D.`;
  if (summary.startsWith(machineOpening)) summary = `${LABELS[type] ?? "Make a change to your records"}.${summary.slice(machineOpening.length)}`;
  if (type === "command.undo" && typeof payload.commandId === "string") {
    // The shared describer names the earlier change by its command name in brackets; the owner reads its label.
    const target = await first<{ type: string }>(db, "SELECT type FROM commands WHERE user_id = ? AND command_id = ?", userId, payload.commandId);
    const machineName = target ? ` (\u201C${target.type}\u201D)` : null;
    if (target && machineName && summary.includes(machineName)) summary = summary.replace(machineName, LABELS[target.type] ? ` (${LABELS[target.type]!.charAt(0).toLowerCase()}${LABELS[target.type]!.slice(1)})` : "");
  }
  // The bound holds for the text the owner actually reads, after the rewording above.
  if (summary.length > MAX_SUMMARY_CHARS) throw new CommandError("invalid_command", "This request is too long to be shown to the owner in full, and a request is never confirmed on a shortened summary", { reason: "summary_too_long" });
  return summary;
}

/** Whether the whole request can be put before the owner: every field, every value in full, within the bounds. */
export async function canBeShownInFull(db: Db, userId: string, type: string, payload: Record<string, unknown>): Promise<boolean> {
  try {
    await describeSubmittedChange(db, userId, type, payload);
    return true;
  } catch (error) {
    if (isCommandError(error) && (error.details as { reason?: unknown } | undefined)?.reason === "summary_too_long") return false;
    throw error;
  }
}

/**
 * What the owner reads for a stored request, and whether it may be confirmed. A request that cannot be
 * described in full (it was kept before the bounds existed, or describing it failed) is still listed, so
 * the owner can see that it is there and reject it, but with a plain statement instead of its content and
 * marked as not confirmable: the owner never confirms what they were not shown, and never reads raw
 * fields or identifiers in its place.
 */
export async function summaryForOwner(db: Db, userId: string, type: string, payload: Record<string, unknown>): Promise<{ summary: string; showable: boolean }> {
  try {
    return { summary: await describeSubmittedChange(db, userId, type, payload), showable: true };
  } catch {
    return { summary: notShownSummary(type), showable: false };
  }
}

/** The statement shown in place of a request that cannot be put before the owner in full. */
export const notShownSummary = (type: string): string =>
  `${LABELS[type] ?? "A change to your records"}. This request cannot be shown to you in full, so it cannot be confirmed. Reject it; if the change is still wanted, it can be asked for again in a shorter form.`;
