-- Daily service (specification sections 7 and 9; trips and pause from sections 10 and 21).
-- Every personal table carries user_id with owner-qualified keys. The weather cache is the one shared
-- table and deliberately holds no user identifier.

-- ---------------------------------------------------------------------------------------------
-- Weather: shared provider cache (no user IDs) and each owner's private snapshot references
-- ---------------------------------------------------------------------------------------------
CREATE TABLE weather_cache (
  cache_key    TEXT PRIMARY KEY,           -- provider | coarse lat | coarse lon | local date
  provider     TEXT NOT NULL,
  latitude     REAL NOT NULL,              -- coarse (0.1 degree) location
  longitude    REAL NOT NULL,
  timezone     TEXT NOT NULL,
  local_date   TEXT NOT NULL,
  fetched_at   TEXT NOT NULL,
  issued_at    TEXT,
  covers_from  TEXT,
  covers_to    TEXT,
  payload_json TEXT NOT NULL               -- normalized provider forecast (hours, alerts, missing fields)
);

CREATE TABLE weather_snapshots (
  user_id       TEXT NOT NULL REFERENCES users(user_id),
  snapshot_id   TEXT NOT NULL,
  local_date    TEXT NOT NULL,
  purpose       TEXT NOT NULL,
  provider      TEXT NOT NULL,
  freshness     TEXT NOT NULL CHECK (freshness IN ('fresh', 'stale', 'unavailable')),
  location_label TEXT NOT NULL,
  fetched_at    TEXT NOT NULL,
  snapshot_json TEXT NOT NULL,
  command_id    TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  PRIMARY KEY (user_id, snapshot_id)
);
CREATE INDEX weather_snapshots_date ON weather_snapshots(user_id, local_date, created_at);

CREATE TABLE calendar_snapshots (
  user_id       TEXT NOT NULL REFERENCES users(user_id),
  snapshot_id   TEXT NOT NULL,
  local_date    TEXT NOT NULL,
  status        TEXT NOT NULL CHECK (status IN ('ok', 'not_connected', 'error', 'stale')),
  read_at       TEXT,
  snapshot_json TEXT NOT NULL,
  command_id    TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  PRIMARY KEY (user_id, snapshot_id)
);
CREATE INDEX calendar_snapshots_date ON calendar_snapshots(user_id, local_date, created_at);

-- ---------------------------------------------------------------------------------------------
-- Boards: one per owner, scope and local date; immutable revisions; complete validated options
-- ---------------------------------------------------------------------------------------------
CREATE TABLE boards (
  user_id            TEXT NOT NULL REFERENCES users(user_id),
  board_id           TEXT NOT NULL,
  scope              TEXT NOT NULL DEFAULT 'home',   -- 'home' or 'trip:<tripId>'
  local_date         TEXT NOT NULL,
  timezone           TEXT NOT NULL,
  current_revision   INTEGER NOT NULL CHECK (current_revision > 0),
  status             TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'worn', 'suppressed')),
  suppression_reason TEXT,                           -- 'owner_request' | 'pause' | 'calendar_event_deleted'
  selected_option_id TEXT,
  selected_footwear_id TEXT,
  selected_at        TEXT,
  exposure_id        TEXT,                           -- the open exposure set mirroring the offered options
  needs_replenishment INTEGER NOT NULL DEFAULT 0,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL,
  PRIMARY KEY (user_id, board_id),
  UNIQUE (user_id, scope, local_date)
);
CREATE INDEX boards_open ON boards(user_id, status, local_date);

CREATE TABLE board_revisions (
  user_id         TEXT NOT NULL,
  board_id        TEXT NOT NULL,
  revision        INTEGER NOT NULL CHECK (revision > 0),
  reason          TEXT NOT NULL,
  requested_count INTEGER NOT NULL,
  brief_json      TEXT NOT NULL,
  conditions_json TEXT NOT NULL,          -- DayConditions used for validation (weather basis and intervals)
  context_json    TEXT NOT NULL,          -- source revisions, snapshot refs, rule versions, probability model
  day_line        TEXT NOT NULL,
  weather_line    TEXT,
  suitability_line TEXT,
  notice          TEXT,
  changes_json    TEXT NOT NULL DEFAULT '[]',
  weather_snapshot_id  TEXT,
  calendar_snapshot_id TEXT,
  command_id      TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  PRIMARY KEY (user_id, board_id, revision),
  FOREIGN KEY (user_id, board_id) REFERENCES boards(user_id, board_id)
);

CREATE TABLE board_options (
  user_id      TEXT NOT NULL,
  board_id     TEXT NOT NULL,
  revision     INTEGER NOT NULL,
  option_id    TEXT NOT NULL,
  state        TEXT NOT NULL CHECK (state IN ('offered', 'reserve')),
  position     INTEGER NOT NULL,
  slots_json   TEXT NOT NULL,             -- [{ role, garmentId }]
  footwear_alternatives_json TEXT NOT NULL DEFAULT '[]',
  reason       TEXT NOT NULL,
  suits_event_ids_json TEXT NOT NULL DEFAULT '[]',
  evidence_json TEXT NOT NULL,            -- OptionEvidence
  changed      INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, board_id, revision, option_id),
  FOREIGN KEY (user_id, board_id, revision) REFERENCES board_revisions(user_id, board_id, revision)
);

-- Index of garments per option, so a changed garment finds the open boards that depend on it.
CREATE TABLE board_option_garments (
  user_id    TEXT NOT NULL,
  board_id   TEXT NOT NULL,
  revision   INTEGER NOT NULL,
  option_id  TEXT NOT NULL,
  garment_id TEXT NOT NULL,
  role       TEXT NOT NULL,
  alternative INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, board_id, revision, option_id, garment_id),
  FOREIGN KEY (user_id, board_id, revision, option_id) REFERENCES board_options(user_id, board_id, revision, option_id),
  FOREIGN KEY (user_id, garment_id) REFERENCES garments(user_id, garment_id)
);
CREATE INDEX board_option_garments_garment ON board_option_garments(user_id, garment_id);

-- A day's board removed or paused on request: retries and scheduled runs cannot recreate it.
CREATE TABLE board_suppressions (
  user_id     TEXT NOT NULL REFERENCES users(user_id),
  scope       TEXT NOT NULL,
  local_date  TEXT NOT NULL,
  reason      TEXT NOT NULL,              -- 'owner_request' | 'calendar_event_deleted'
  note        TEXT,
  status      TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'lifted')),
  command_id  TEXT,
  created_at  TEXT NOT NULL,
  lifted_at   TEXT,
  PRIMARY KEY (user_id, scope, local_date)
);

-- ---------------------------------------------------------------------------------------------
-- Managed Calendar event per board: stable event ID, verified revision, suppression
-- ---------------------------------------------------------------------------------------------
CREATE TABLE calendar_projections (
  user_id            TEXT NOT NULL REFERENCES users(user_id),
  target_key         TEXT NOT NULL,       -- 'outfit-event:<scope>:<localDate>'
  board_id           TEXT NOT NULL,
  local_date         TEXT NOT NULL,
  calendar_id        TEXT,
  event_id           TEXT NOT NULL,
  state              TEXT NOT NULL DEFAULT 'pending'
                     CHECK (state IN ('pending', 'projected', 'failed', 'not_connected', 'suppressed')),
  suppression_reason TEXT,                -- 'owner_request' | 'pause' | 'deleted_externally'
  projected_revision INTEGER,
  etag               TEXT,
  managed_text       TEXT,                -- managed description last written (to preserve unmanaged content)
  last_verified_at   TEXT,
  last_error         TEXT,
  lock_until         TEXT,                -- serializes projection per managed event
  updated_at         TEXT NOT NULL,
  PRIMARY KEY (user_id, target_key)
);

-- ---------------------------------------------------------------------------------------------
-- Scheduled phases: one run per owner, local day and phase
-- ---------------------------------------------------------------------------------------------
CREATE TABLE day_runs (
  user_id      TEXT NOT NULL REFERENCES users(user_id),
  local_date   TEXT NOT NULL,             -- the board's local date
  phase        TEXT NOT NULL CHECK (phase IN ('evening_compose', 'morning_refresh', 'morning_publish', 'morning_present', 'resume')),
  status       TEXT NOT NULL CHECK (status IN ('running', 'succeeded', 'failed', 'skipped_paused')),
  due_at       TEXT NOT NULL,             -- UTC instant of the local schedule time
  timezone     TEXT NOT NULL,
  attempts     INTEGER NOT NULL DEFAULT 1,
  lease_until  TEXT,
  started_at   TEXT NOT NULL,
  finished_at  TEXT,
  detail_json  TEXT NOT NULL DEFAULT '{}',
  PRIMARY KEY (user_id, local_date, phase)
);
CREATE INDEX day_runs_status ON day_runs(status, lease_until);

-- ---------------------------------------------------------------------------------------------
-- Pause and resume
-- ---------------------------------------------------------------------------------------------
CREATE TABLE service_pauses (
  user_id     TEXT NOT NULL REFERENCES users(user_id),
  pause_id    TEXT NOT NULL,
  starts_on   TEXT NOT NULL,              -- first paused local date
  resume_on   TEXT,                       -- first active local date; NULL = indefinite
  status      TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'ended')),
  created_at  TEXT NOT NULL,
  ended_at    TEXT,
  command_id  TEXT NOT NULL,
  ended_by_command_id TEXT,
  PRIMARY KEY (user_id, pause_id)
);
CREATE UNIQUE INDEX service_pauses_one_active ON service_pauses(user_id) WHERE status = 'active';

-- ---------------------------------------------------------------------------------------------
-- Trips and proposed packing (physically packed quantities live in the stock ledger)
-- ---------------------------------------------------------------------------------------------
CREATE TABLE trips (
  user_id           TEXT NOT NULL REFERENCES users(user_id),
  trip_id           TEXT NOT NULL,
  version           INTEGER NOT NULL DEFAULT 1,
  name              TEXT NOT NULL,
  departs_on        TEXT NOT NULL,
  returns_on        TEXT NOT NULL,
  destinations_json TEXT NOT NULL,
  occasions_json    TEXT NOT NULL DEFAULT '[]',
  luggage_json      TEXT,
  laundry_json      TEXT NOT NULL DEFAULT '[]',
  status            TEXT NOT NULL DEFAULT 'planned' CHECK (status IN ('planned', 'cancelled')),
  source_json       TEXT NOT NULL,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  PRIMARY KEY (user_id, trip_id),
  CHECK (returns_on >= departs_on)
);

CREATE TABLE trip_packing_proposals (
  user_id       TEXT NOT NULL,
  trip_id       TEXT NOT NULL,
  revision      INTEGER NOT NULL,
  proposal_json TEXT NOT NULL,
  command_id    TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  PRIMARY KEY (user_id, trip_id, revision),
  FOREIGN KEY (user_id, trip_id) REFERENCES trips(user_id, trip_id)
);
