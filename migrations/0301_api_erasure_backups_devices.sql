-- API, MCP and identity workstream, migration 0301: account erasure records, backups, notification devices.
--
-- 0300 is applied in existing databases, so everything new is additive here.

-- ---------------------------------------------------------------------------------------------
-- Account erasure. A confirmed deletion erases every stored record of the owner, in every store.
-- This table is the only thing that remains: it holds no personal data, only a keyed hash of the
-- internal user ID (so a backup of the erased account can be recognised and refused) and what was
-- erased where. `pending_owner_id` exists only while erasure is unfinished and is cleared with it.
-- It deliberately has no `user_id` column: erasure removes every row that has one.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE account_erasures (
  erasure_id        TEXT PRIMARY KEY,
  owner_ref         TEXT NOT NULL UNIQUE,
  pending_owner_id  TEXT,
  state             TEXT NOT NULL CHECK (state IN ('pending', 'erased')),
  confirmed_at      TEXT NOT NULL,
  erased_at         TEXT,
  attempts          INTEGER NOT NULL DEFAULT 0,
  stores_json       TEXT NOT NULL DEFAULT '{}',
  last_error        TEXT,
  CHECK ((state = 'erased') = (pending_owner_id IS NULL))
);
CREATE INDEX account_erasures_pending ON account_erasures(state) WHERE state = 'pending';

-- ---------------------------------------------------------------------------------------------
-- Backups are packages built by the same job as a portable export, kept under their own prefix with
-- their own retention, each with a restore manifest (snapshot times and projection watermarks).
-- ---------------------------------------------------------------------------------------------
ALTER TABLE export_jobs ADD COLUMN purpose TEXT NOT NULL DEFAULT 'export' CHECK (purpose IN ('export', 'backup'));
ALTER TABLE export_jobs ADD COLUMN restore_manifest_json TEXT;
CREATE INDEX export_jobs_purpose ON export_jobs(user_id, purpose, requested_at);

-- ---------------------------------------------------------------------------------------------
-- Devices that receive notifications (APNs). The device token is a delivery credential: it is stored
-- encrypted, looked up by a keyed hash, never exported and never returned by any route.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE notification_devices (
  user_id          TEXT NOT NULL REFERENCES users(user_id),
  device_id        TEXT NOT NULL,
  platform         TEXT NOT NULL CHECK (platform IN ('ios')),
  environment      TEXT NOT NULL CHECK (environment IN ('development', 'production')),
  token_hash       TEXT NOT NULL UNIQUE,
  token_cipher     TEXT NOT NULL,
  token_iv         TEXT NOT NULL,
  status           TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  disabled_reason  TEXT,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  last_delivery_at TEXT,
  PRIMARY KEY (user_id, device_id)
);
