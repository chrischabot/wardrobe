-- API, MCP and identity workstream, migration 0302: reminder events on the outfit calendar, and
-- the once-per-phase marker of the scheduled connection health check. Additive only.

-- ---------------------------------------------------------------------------------------------
-- A reminder set in conversation is also shown on the owner's dedicated outfit calendar (effect
-- `calendar.project_reminder`, planned by the assistant workstream). This records which event was
-- written where, so a changed reminder updates the same event and a removed reminder's event is
-- deleted. It is a projection record: it is rebuilt by projecting again and is not exported.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE reminder_calendar_events (
  user_id           TEXT NOT NULL REFERENCES users(user_id),
  reminder_id       TEXT NOT NULL,
  calendar_id       TEXT NOT NULL,
  event_id          TEXT NOT NULL,
  projected_version INTEGER NOT NULL,
  projected_at      TEXT NOT NULL,
  removed_at        TEXT,
  PRIMARY KEY (user_id, reminder_id)
);
CREATE INDEX reminder_calendar_events_live ON reminder_calendar_events(user_id) WHERE removed_at IS NULL;

-- ---------------------------------------------------------------------------------------------
-- Connection health is checked once before the evening composition and once before the morning
-- delivery of each local day (specification section 15). The row is the claim: the sweep runs every
-- five minutes and must not probe the owner's services every time.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE connection_health_runs (
  user_id     TEXT NOT NULL REFERENCES users(user_id),
  local_date  TEXT NOT NULL,
  phase       TEXT NOT NULL CHECK (phase IN ('evening', 'morning')),
  ran_at      TEXT NOT NULL,
  result_json TEXT NOT NULL DEFAULT '{}',
  PRIMARY KEY (user_id, local_date, phase)
);
