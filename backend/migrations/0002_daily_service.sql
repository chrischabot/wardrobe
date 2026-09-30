-- Garderobe migration 0002: daily service (weather, board documents, Calendar projection, trips).
-- Owned by the daily-service workstream. Never edit after release; add later numbered files.

-- ---------------------------------------------------------------- weather cache
-- Shared forecast cache keyed by provider, coarse location and interval. It deliberately carries no
-- user identifier (spec section 7): each private board stores its own snapshot copy and reference.
CREATE TABLE weather_cache (
  cache_key TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  lat_key TEXT NOT NULL,
  lon_key TEXT NOT NULL,
  timezone TEXT NOT NULL,
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL,
  fetched_at TEXT NOT NULL,
  issued_at TEXT,
  snapshot_json TEXT NOT NULL
);

-- ---------------------------------------------------------------- board documents
-- The shared semantic outfit document (app, web board, Calendar) of one immutable board revision.
CREATE TABLE board_documents (
  user_id TEXT NOT NULL,
  board_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  document_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (user_id, board_id, revision),
  FOREIGN KEY (user_id, board_id, revision) REFERENCES board_revisions (user_id, board_id, revision)
);

-- ---------------------------------------------------------------- Calendar projection
-- One managed event per owner and local date. desired_seq increases with every new board revision or
-- selection; projected_seq only moves forward after a verified read-back, so a delayed older write
-- can never be recorded as the current projection. Suppression (pause, explicit removal, external
-- deletion) prevents retries from recreating the event.
CREATE TABLE calendar_projections (
  user_id TEXT NOT NULL REFERENCES users(user_id),
  board_date TEXT NOT NULL,
  board_id TEXT NOT NULL,
  purpose TEXT NOT NULL,
  event_id TEXT NOT NULL,
  calendar_id TEXT,
  desired_seq INTEGER NOT NULL DEFAULT 0,
  desired_revision INTEGER NOT NULL DEFAULT 0,
  projected_seq INTEGER NOT NULL DEFAULT 0,
  projected_revision INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'projected', 'failed', 'suppressed')),
  suppressed_reason TEXT,
  etag TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  lease_until TEXT,
  projected_at TEXT,
  updated_at TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (user_id, board_date),
  UNIQUE (user_id, event_id),
  CHECK (projected_seq <= desired_seq)
);
CREATE INDEX calendar_projections_pending ON calendar_projections (status, board_date);

-- ---------------------------------------------------------------- trips and packing
-- Proposed packing and physically packed quantities stay distinct; unpacking never asserts washing.
ALTER TABLE trips ADD COLUMN allow_repeats INTEGER NOT NULL DEFAULT 1;
ALTER TABLE trips ADD COLUMN occasions_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE trips ADD COLUMN packed_at TEXT;
ALTER TABLE trips ADD COLUMN unpacked_at TEXT;
ALTER TABLE trips ADD COLUMN created_at TEXT;
ALTER TABLE trip_items ADD COLUMN packed_at TEXT;
ALTER TABLE trip_items ADD COLUMN unpacked_at TEXT;
ALTER TABLE trip_items ADD COLUMN unpacked_qty INTEGER NOT NULL DEFAULT 0;
