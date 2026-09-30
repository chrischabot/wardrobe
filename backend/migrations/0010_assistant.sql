-- Garderobe migration 0010: assistant and integrations (assistant workstream).
-- New tables only; 0001 is frozen. Every private row carries user_id and owner-qualified keys.

-- ---------------------------------------------------------------- conversation turns
-- Stable client turn identity: the client mints client_turn_id before sending; the backend binds it
-- to the owner and the canonical request body. A resubmission returns the existing turn; the same id
-- with a different body is rejected.
CREATE TABLE assistant_turns (
  user_id TEXT NOT NULL REFERENCES users(user_id),
  turn_id TEXT NOT NULL,
  client_turn_id TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  channel TEXT NOT NULL,
  intent_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'cancelled', 'failed', 'deterministic')),
  submission_id TEXT,
  user_message_id TEXT NOT NULL,
  profile_version INTEGER,
  context_digest TEXT,
  result_json TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id, turn_id),
  UNIQUE (user_id, client_turn_id)
);
CREATE INDEX assistant_turns_by_status ON assistant_turns (user_id, status, created_at);

-- Settled result cards from background work, appended once at a message boundary.
CREATE TABLE assistant_deliveries (
  user_id TEXT NOT NULL REFERENCES users(user_id),
  delivery_id TEXT NOT NULL,
  job_ref TEXT NOT NULL,
  card_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'appended')),
  appended_message_id TEXT,
  created_at TEXT NOT NULL,
  appended_at TEXT,
  PRIMARY KEY (user_id, delivery_id)
);

-- ---------------------------------------------------------------- inference accounting
-- Spend is reserved before dispatch and settled against reported usage (spec section 12).
CREATE TABLE model_reservations (
  user_id TEXT NOT NULL REFERENCES users(user_id),
  reservation_id TEXT NOT NULL,
  task TEXT NOT NULL,
  profile_id TEXT NOT NULL,
  run_ref TEXT NOT NULL,
  reserved_micro_usd INTEGER NOT NULL CHECK (reserved_micro_usd >= 0),
  actual_micro_usd INTEGER,
  status TEXT NOT NULL CHECK (status IN ('reserved', 'settled', 'released', 'uncertain')),
  period TEXT NOT NULL,
  created_at TEXT NOT NULL,
  settled_at TEXT,
  PRIMARY KEY (user_id, reservation_id)
);
CREATE INDEX model_reservations_by_period ON model_reservations (user_id, period, task);

CREATE TABLE model_runs (
  user_id TEXT NOT NULL REFERENCES users(user_id),
  run_id TEXT NOT NULL,
  reservation_id TEXT,
  task TEXT NOT NULL,
  profile_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  gateway_id TEXT NOT NULL,
  route TEXT NOT NULL,
  prompt_version TEXT,
  profile_version INTEGER,
  input_tokens INTEGER,
  output_tokens INTEGER,
  status TEXT NOT NULL,
  error_class TEXT,
  fallback_of TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (user_id, run_id)
);

-- ---------------------------------------------------------------- compaction
CREATE TABLE compaction_checkpoints (
  user_id TEXT NOT NULL REFERENCES users(user_id),
  checkpoint_id TEXT NOT NULL,
  from_message_id TEXT NOT NULL,
  to_message_id TEXT NOT NULL,
  covered_count INTEGER NOT NULL,
  token_estimate INTEGER NOT NULL,
  model TEXT NOT NULL,
  prompt_version TEXT NOT NULL,
  summary_sha256 TEXT NOT NULL,
  covered_ids_json TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL CHECK (status IN ('active', 'rejected', 'invalidated')),
  reason TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (user_id, checkpoint_id)
);

-- ---------------------------------------------------------------- recall projection (rebuildable)
-- Think Session is canonical for transcript text; this projection is rebuilt from it.
CREATE TABLE recall_messages (
  user_id TEXT NOT NULL REFERENCES users(user_id),
  message_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  conversation_id TEXT NOT NULL,
  role TEXT NOT NULL,
  speaker TEXT NOT NULL CHECK (speaker IN ('owner', 'assistant', 'system', 'tool')),
  channel TEXT,
  authored_at TEXT NOT NULL,
  event_at TEXT,
  text TEXT NOT NULL,
  terms TEXT NOT NULL,
  entity_ids_json TEXT NOT NULL DEFAULT '[]',
  revision INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (user_id, message_id)
);
CREATE INDEX recall_messages_by_time ON recall_messages (user_id, authored_at);
CREATE UNIQUE INDEX recall_messages_by_seq ON recall_messages (user_id, seq);

CREATE TABLE recall_judgments (
  user_id TEXT NOT NULL REFERENCES users(user_id),
  judgment_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  speaker TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('liked', 'rejected', 'ordered', 'returned', 'worn', 'recommended', 'fit_reversal')),
  subject TEXT NOT NULL,
  category TEXT,
  entity_id TEXT,
  quote TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  superseded_by TEXT,
  PRIMARY KEY (user_id, judgment_id)
);
CREATE INDEX recall_judgments_by_time ON recall_judgments (user_id, occurred_at);

-- Projection watermark: source cursor (canonical seq seen) vs indexed cursor (upload confirmed).
CREATE TABLE recall_watermarks (
  user_id TEXT NOT NULL REFERENCES users(user_id),
  index_name TEXT NOT NULL,
  source_seq INTEGER NOT NULL DEFAULT 0,
  indexed_seq INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id, index_name)
);

-- Local implementation of the search index (tests and local runs). Production uses one AI Search
-- instance per user; both sit behind the same SearchIndex interface and the same watermark.
CREATE TABLE recall_index_docs (
  user_id TEXT NOT NULL REFERENCES users(user_id),
  source_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  kind TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  terms TEXT NOT NULL,
  body TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'indexed' CHECK (status IN ('pending', 'indexed')),
  PRIMARY KEY (user_id, source_id)
);

-- Read-time tombstones: a deleted source never reappears from summaries, indexes or restores.
CREATE TABLE recall_tombstones (
  user_id TEXT NOT NULL REFERENCES users(user_id),
  source_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  erasure_status TEXT NOT NULL DEFAULT 'pending' CHECK (erasure_status IN ('pending', 'complete')),
  created_at TEXT NOT NULL,
  PRIMARY KEY (user_id, source_id)
);

-- ---------------------------------------------------------------- outbound connections
CREATE TABLE connections (
  user_id TEXT NOT NULL REFERENCES users(user_id),
  connection_id TEXT NOT NULL,
  name TEXT NOT NULL,
  namespace TEXT NOT NULL,
  kind TEXT NOT NULL,
  endpoint TEXT NOT NULL,
  expected_issuer TEXT,
  credential_ref TEXT,
  transport TEXT NOT NULL,
  protocol_version TEXT NOT NULL,
  tools_json TEXT NOT NULL DEFAULT '[]',
  schema_digest TEXT,
  allowed_effects_json TEXT NOT NULL DEFAULT '["read"]',
  data_classes_json TEXT NOT NULL DEFAULT '[]',
  limits_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL CHECK (status IN ('active', 'reconnect_required', 'disconnected')),
  health_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (user_id, connection_id),
  UNIQUE (user_id, namespace)
);

CREATE TABLE connector_calls (
  user_id TEXT NOT NULL REFERENCES users(user_id),
  call_id TEXT NOT NULL,
  connection_id TEXT NOT NULL,
  tool TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
  input_sha256 TEXT NOT NULL,
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id, call_id),
  FOREIGN KEY (user_id, connection_id) REFERENCES connections (user_id, connection_id)
);

-- ---------------------------------------------------------------- research evidence
CREATE TABLE research_evidence (
  user_id TEXT NOT NULL REFERENCES users(user_id),
  evidence_id TEXT NOT NULL,
  project_ref TEXT NOT NULL,
  canonical_url TEXT NOT NULL,
  final_url TEXT NOT NULL,
  method TEXT NOT NULL,
  retrieved_at TEXT NOT NULL,
  country TEXT,
  currency TEXT,
  price_minor INTEGER,
  variant_json TEXT NOT NULL DEFAULT '{}',
  availability TEXT NOT NULL CHECK (availability IN ('available', 'unavailable', 'unknown')),
  completeness TEXT NOT NULL,
  content_sha256 TEXT NOT NULL,
  anchors_json TEXT NOT NULL DEFAULT '[]',
  PRIMARY KEY (user_id, evidence_id)
);
CREATE INDEX research_evidence_by_project ON research_evidence (user_id, project_ref, retrieved_at);

-- ---------------------------------------------------------------- email intake
-- One row per processed provider message: repeated syncs and forwarded duplicates are no-ops.
CREATE TABLE email_sources (
  user_id TEXT NOT NULL REFERENCES users(user_id),
  provider TEXT NOT NULL,
  external_message_id TEXT NOT NULL,
  thread_id TEXT,
  kind TEXT NOT NULL,
  merchant TEXT,
  merchant_order_number TEXT,
  command_id TEXT,
  outcome TEXT NOT NULL,
  processed_at TEXT NOT NULL,
  PRIMARY KEY (user_id, provider, external_message_id)
);

-- ---------------------------------------------------------------- identity security
-- Sessions and consumer grants issued before these instants are invalid (recovery revokes them).
CREATE TABLE identity_security (
  user_id TEXT PRIMARY KEY REFERENCES users(user_id),
  sessions_valid_after TEXT,
  grants_valid_after TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL
);

CREATE TABLE recovery_attempts (
  user_id TEXT,
  attempt_id TEXT NOT NULL PRIMARY KEY,
  outcome TEXT NOT NULL,
  created_at TEXT NOT NULL
);
