-- API, MCP and identity workstream, migration 0309: in-flight relayed turn admissions.
--
-- Before `garderobe_ask` dispatches a new relayed conversation turn to the assistant actor, it admits the
-- turn here in one atomic statement that checks the connection's and the owner's waiting-request limits
-- (including `WAITING_LIMITS.perRelayedTurn` for the new turn). Each call inserts its own `admission_id`
-- row and removes it in `finally`; while the row exists and `assistant_turns` has not yet recorded the
-- submission, `waitingRequests` and subsequent admissions count `WAITING_LIMITS.perRelayedTurn` once per
-- distinct `submission_id` in the same SQL snapshot. Once `assistant_turns` records the turn, the turn row
-- itself carries the reservation until the turn reaches a terminal status.
CREATE TABLE relayed_turn_admissions (
  user_id       TEXT NOT NULL REFERENCES users(user_id),
  submission_id TEXT NOT NULL,
  admission_id  TEXT NOT NULL,
  grant_id      TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  PRIMARY KEY (user_id, submission_id, admission_id)
);
CREATE INDEX relayed_turn_admissions_user_created ON relayed_turn_admissions(user_id, created_at);
