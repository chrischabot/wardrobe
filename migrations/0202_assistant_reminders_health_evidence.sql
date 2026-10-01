-- Assistant workstream, second migration: reminders set from conversation, connection health and issuer,
-- run evidence on inference reservations, compaction token estimates, AI Search instance records.

ALTER TABLE compaction_checkpoints ADD COLUMN token_estimate INTEGER;

ALTER TABLE inference_reservations ADD COLUMN schema_version TEXT;
ALTER TABLE inference_reservations ADD COLUMN effort_json TEXT;
ALTER TABLE inference_reservations ADD COLUMN evidence_json TEXT;

ALTER TABLE connections ADD COLUMN expected_issuer TEXT;
ALTER TABLE connections ADD COLUMN health_json TEXT;

-- Reminders for drops and windows: a managed event type distinct from outfit delivery.
CREATE TABLE reminders (
  user_id     TEXT NOT NULL REFERENCES users(user_id),
  reminder_id TEXT NOT NULL,
  version     INTEGER NOT NULL DEFAULT 1,
  kind        TEXT NOT NULL,
  title       TEXT NOT NULL,
  note        TEXT,
  due_at      TEXT NOT NULL,
  url         TEXT,
  status      TEXT NOT NULL CHECK (status IN ('active', 'cancelled')),
  source_ref  TEXT,
  command_id  TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  PRIMARY KEY (user_id, reminder_id)
);
CREATE INDEX reminders_due ON reminders(user_id, status, due_at);

-- Which private AI Search instance was provisioned for an owner in an environment (administrative record).
CREATE TABLE search_instances (
  user_id        TEXT NOT NULL REFERENCES users(user_id),
  environment    TEXT NOT NULL,
  instance       TEXT NOT NULL,
  gateway_id     TEXT NOT NULL,
  created        INTEGER NOT NULL,
  provisioned_at TEXT NOT NULL,
  command_id     TEXT NOT NULL,
  PRIMARY KEY (user_id, environment)
);

-- Mailbox synchronization for purchase investigations: a watermark per connection and the messages
-- already read, so a later run reads only what is new (bounded backfill, incremental afterwards).
-- Only identifiers and a classification are kept here, never message content.
CREATE TABLE mail_sync_state (
  user_id        TEXT NOT NULL REFERENCES users(user_id),
  connection_id  TEXT NOT NULL,
  history_id     TEXT,
  backfill_from  TEXT,
  backfill_to    TEXT,
  completion     TEXT NOT NULL CHECK (completion IN ('complete', 'partial')),
  resume_json    TEXT,
  updated_at     TEXT NOT NULL,
  PRIMARY KEY (user_id, connection_id)
);
CREATE TABLE mail_seen (
  user_id        TEXT NOT NULL REFERENCES users(user_id),
  connection_id  TEXT NOT NULL,
  message_id     TEXT NOT NULL,
  classified     TEXT NOT NULL CHECK (classified IN ('order', 'not_order', 'unreadable')),
  sent_at        TEXT,
  seen_at        TEXT NOT NULL,
  PRIMARY KEY (user_id, connection_id, message_id)
);
