-- API, MCP and identity workstream, migration 0303: the owner's decisions on proposals.
--
-- A change the assistant could not make on its own authority (a read-only connection, or a sensitive
-- change asked for through a connected assistant) is kept by the assistant workstream as a proposal on
-- the turn that produced it. This table records what the owner then decided, in the app: confirmed
-- (with the command that carried it out) or rejected. A proposal with no row here is still pending.
-- The proposal identifier is derived from the turn and the proposed change, so it is stable.
CREATE TABLE proposal_decisions (
  user_id      TEXT NOT NULL REFERENCES users(user_id),
  proposal_id  TEXT NOT NULL,
  turn_id      TEXT NOT NULL,
  command_type TEXT NOT NULL,
  decision     TEXT NOT NULL CHECK (decision IN ('confirmed', 'rejected')),
  command_id   TEXT,
  decided_at   TEXT NOT NULL,
  channel      TEXT NOT NULL,
  PRIMARY KEY (user_id, proposal_id),
  CHECK ((decision = 'confirmed') = (command_id IS NOT NULL))
);
