-- API, MCP and identity workstream, migration 0304: proposals that do not come from an assistant turn.
--
-- A sensitive change is carried out only after the signed-in owner confirms it in the app. Two kinds of
-- request therefore wait here instead of running:
--   typed_command  a connected assistant sent a sensitive typed command through `garderobe_command`;
--   relayed_turn   Garderobe's own assistant, acting on text relayed by a connected assistant, tried a
--                  command that is not on the short list allowed for relayed text.
-- The row holds the command exactly as it would run (type, payload, expected versions, occurrence time).
-- The owner's decision is recorded in `proposal_decisions` (0303), as for a proposal kept on a turn.
-- The identifier is derived from the origin and the exact request, so a changed request is a different
-- proposal and a repeated request is the same one.
CREATE TABLE submitted_proposals (
  user_id                TEXT NOT NULL REFERENCES users(user_id),
  proposal_id            TEXT NOT NULL,
  origin                 TEXT NOT NULL CHECK (origin IN ('typed_command', 'relayed_turn')),
  -- The assistant grant (typed_command) or the turn (relayed_turn) the request came from.
  source_ref             TEXT NOT NULL,
  grant_id               TEXT,
  turn_id                TEXT,
  idempotency_key        TEXT NOT NULL,
  request_hash           TEXT NOT NULL,
  command_type           TEXT NOT NULL,
  payload_json           TEXT NOT NULL,
  expected_versions_json TEXT NOT NULL DEFAULT '{}',
  occurred_at            TEXT,
  created_at             TEXT NOT NULL,
  PRIMARY KEY (user_id, proposal_id),
  UNIQUE (user_id, origin, source_ref, idempotency_key)
);
CREATE INDEX submitted_proposals_created ON submitted_proposals(user_id, created_at);
