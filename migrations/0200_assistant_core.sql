-- Garderobe assistant workstream (migrations 0200-0299).
-- Every personal table carries user_id, owner-qualified primary keys and compound foreign keys.
-- Domain tables here are written only by assistant-lane commands through the shared command service.
-- The turn ledger, turn events and the retrieval projection are operational/derived stores written by
-- the conversation actor; they are rebuildable from the Think transcript and the command ledger.

-- ---------------------------------------------------------------------------------------------
-- Conversation turns (stable turn identity, replayable events)
-- ---------------------------------------------------------------------------------------------

CREATE TABLE assistant_turns (
  user_id            TEXT NOT NULL REFERENCES users(user_id),
  turn_id            TEXT NOT NULL,
  submission_id      TEXT NOT NULL,
  request_hash       TEXT NOT NULL,
  kind               TEXT NOT NULL DEFAULT 'conversation',
  channel            TEXT NOT NULL,
  scopes_json        TEXT NOT NULL,
  auth_ref           TEXT NOT NULL,
  status             TEXT NOT NULL CHECK (status IN ('accepted', 'running', 'needs_input', 'completed', 'failed', 'cancelled', 'resumable')),
  user_message_id    TEXT NOT NULL,
  reply_message_id   TEXT,
  reply_text         TEXT,
  receipts_json      TEXT NOT NULL DEFAULT '[]',
  refusals_json      TEXT NOT NULL DEFAULT '[]',
  proposals_json     TEXT NOT NULL DEFAULT '[]',
  clarification_json TEXT,
  result_json        TEXT,
  failure_json       TEXT,
  model_profile      TEXT,
  next_event_seq     INTEGER NOT NULL DEFAULT 1,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL,
  completed_at       TEXT,
  PRIMARY KEY (user_id, turn_id),
  UNIQUE (user_id, submission_id)
);
CREATE INDEX assistant_turns_status ON assistant_turns(user_id, status, created_at);

CREATE TABLE assistant_turn_events (
  user_id    TEXT NOT NULL,
  turn_id    TEXT NOT NULL,
  seq        INTEGER NOT NULL,
  type       TEXT NOT NULL,
  at         TEXT NOT NULL,
  data_json  TEXT NOT NULL,
  PRIMARY KEY (user_id, turn_id, seq),
  FOREIGN KEY (user_id, turn_id) REFERENCES assistant_turns(user_id, turn_id)
);

-- Deduplicated result deliveries appended to the conversation (one settled card per delivery ID).
CREATE TABLE assistant_deliveries (
  user_id      TEXT NOT NULL REFERENCES users(user_id),
  delivery_id  TEXT NOT NULL,
  message_id   TEXT NOT NULL,
  delivered_at TEXT NOT NULL,
  PRIMARY KEY (user_id, delivery_id)
);

-- ---------------------------------------------------------------------------------------------
-- Retrieval projection over the canonical transcript (rebuildable; never the transcript itself)
-- ---------------------------------------------------------------------------------------------

CREATE TABLE conversation_index (
  user_id         TEXT NOT NULL REFERENCES users(user_id),
  message_id      TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  position        INTEGER NOT NULL,
  channel         TEXT,
  turn_id         TEXT,
  speaker         TEXT NOT NULL CHECK (speaker IN ('owner', 'assistant', 'system')),
  authored_at     TEXT NOT NULL,
  authored_date   TEXT NOT NULL,
  event_date_from TEXT,
  event_date_to   TEXT,
  entity_ids_json TEXT NOT NULL DEFAULT '[]',
  terms           TEXT NOT NULL,
  excerpt         TEXT NOT NULL,
  source_hash     TEXT NOT NULL,
  indexed_at      TEXT NOT NULL,
  PRIMARY KEY (user_id, message_id)
);
CREATE INDEX conversation_index_date ON conversation_index(user_id, authored_date);
CREATE INDEX conversation_index_position ON conversation_index(user_id, conversation_id, position);

-- Typed judgements keep speaker and evidence: the owner's enthusiasm differs from an assistant suggestion.
CREATE TABLE conversation_judgements (
  user_id       TEXT NOT NULL,
  judgement_id  TEXT NOT NULL,
  message_id    TEXT NOT NULL,
  speaker       TEXT NOT NULL CHECK (speaker IN ('owner', 'assistant')),
  kind          TEXT NOT NULL,
  subject       TEXT NOT NULL,
  subject_terms TEXT NOT NULL,
  entity_id     TEXT,
  authored_at   TEXT NOT NULL,
  authored_date TEXT NOT NULL,
  PRIMARY KEY (user_id, judgement_id),
  FOREIGN KEY (user_id, message_id) REFERENCES conversation_index(user_id, message_id)
);
CREATE INDEX conversation_judgements_kind ON conversation_judgements(user_id, kind, authored_date);
CREATE INDEX conversation_judgements_message ON conversation_judgements(user_id, message_id);

-- Projection watermark: the canonical message cursor the index has durably covered.
CREATE TABLE conversation_index_state (
  user_id           TEXT NOT NULL REFERENCES users(user_id),
  conversation_id   TEXT NOT NULL,
  indexed_position  INTEGER NOT NULL DEFAULT 0,
  indexed_through   TEXT,
  search_uploaded_position INTEGER NOT NULL DEFAULT 0,
  updated_at        TEXT NOT NULL,
  PRIMARY KEY (user_id, conversation_id)
);

-- Read-time tombstones. A suppressed source is hidden everywhere immediately; `erased` is recorded
-- per store only after that store confirmed physical removal.
CREATE TABLE source_tombstones (
  user_id               TEXT NOT NULL REFERENCES users(user_id),
  source_kind           TEXT NOT NULL,
  source_id             TEXT NOT NULL,
  reason                TEXT,
  requested_at          TEXT NOT NULL,
  erased_stores_json    TEXT NOT NULL DEFAULT '[]',
  pending_stores_json   TEXT NOT NULL,
  outstanding_retention TEXT,
  state                 TEXT NOT NULL DEFAULT 'suppressed' CHECK (state IN ('suppressed', 'erased')),
  command_id            TEXT NOT NULL,
  PRIMARY KEY (user_id, source_kind, source_id)
);

-- Compaction checkpoints: which messages a summary covers, its model, prompt version and hash.
CREATE TABLE compaction_checkpoints (
  user_id         TEXT NOT NULL REFERENCES users(user_id),
  checkpoint_id   TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  from_message_id TEXT NOT NULL,
  to_message_id   TEXT NOT NULL,
  covered_ids_json TEXT NOT NULL,
  model_profile   TEXT NOT NULL,
  prompt_version  TEXT NOT NULL,
  summary_sha256  TEXT NOT NULL,
  status          TEXT NOT NULL CHECK (status IN ('active', 'invalidated', 'rejected')),
  invalid_reason  TEXT,
  created_at      TEXT NOT NULL,
  PRIMARY KEY (user_id, checkpoint_id)
);

-- ---------------------------------------------------------------------------------------------
-- Remembered conclusions (source-linked; never a second inventory)
-- ---------------------------------------------------------------------------------------------

CREATE TABLE memory_conclusions (
  user_id            TEXT NOT NULL REFERENCES users(user_id),
  conclusion_id      TEXT NOT NULL,
  version            INTEGER NOT NULL DEFAULT 1,
  kind               TEXT NOT NULL,
  text               TEXT NOT NULL,
  speaker            TEXT NOT NULL CHECK (speaker IN ('owner', 'assistant')),
  status             TEXT NOT NULL CHECK (status IN ('candidate', 'active', 'superseded', 'retired', 'forgotten')),
  source_message_ids_json TEXT NOT NULL,
  premises_json      TEXT NOT NULL DEFAULT '[]',
  entity_ids_json    TEXT NOT NULL DEFAULT '[]',
  history_json       TEXT NOT NULL DEFAULT '[]',
  command_id         TEXT NOT NULL,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL,
  PRIMARY KEY (user_id, conclusion_id)
);

-- ---------------------------------------------------------------------------------------------
-- Purchases: orders, lines, events. An order never activates stock.
-- ---------------------------------------------------------------------------------------------

CREATE TABLE orders (
  user_id           TEXT NOT NULL REFERENCES users(user_id),
  order_id          TEXT NOT NULL,
  version           INTEGER NOT NULL DEFAULT 1,
  merchant          TEXT NOT NULL,
  merchant_key      TEXT NOT NULL,
  order_number      TEXT NOT NULL,
  ordered_on        TEXT,
  currency          TEXT,
  total_minor       INTEGER,
  channel           TEXT NOT NULL,
  replaces_order_id TEXT,
  source_refs_json  TEXT NOT NULL DEFAULT '[]',
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  PRIMARY KEY (user_id, order_id),
  UNIQUE (user_id, merchant_key, order_number)
);

CREATE TABLE order_lines (
  user_id            TEXT NOT NULL,
  order_id           TEXT NOT NULL,
  line_id            TEXT NOT NULL,
  line_key           TEXT NOT NULL,
  product_name       TEXT NOT NULL,
  product_code       TEXT,
  fabric_code        TEXT,
  size               TEXT,
  colour             TEXT,
  fit_options_json   TEXT NOT NULL DEFAULT '{}',
  price_minor        INTEGER,
  currency           TEXT,
  quantity           INTEGER NOT NULL CHECK (quantity > 0),
  arrival_estimate   TEXT,
  state              TEXT NOT NULL DEFAULT 'ordered' CHECK (state IN ('ordered', 'dispatched', 'delivered', 'cancelled', 'refunded', 'returned', 'exchanged')),
  garment_id         TEXT,
  delivered_on       TEXT,
  refunded_minor     INTEGER NOT NULL DEFAULT 0 CHECK (refunded_minor >= 0),
  replaces_order_id  TEXT,
  replaces_line_id   TEXT,
  PRIMARY KEY (user_id, order_id, line_id),
  UNIQUE (user_id, order_id, line_key),
  FOREIGN KEY (user_id, order_id) REFERENCES orders(user_id, order_id),
  FOREIGN KEY (user_id, garment_id) REFERENCES garments(user_id, garment_id)
);
CREATE INDEX order_lines_garment ON order_lines(user_id, garment_id);

CREATE TABLE order_events (
  user_id       TEXT NOT NULL,
  event_id      TEXT NOT NULL,
  order_id      TEXT NOT NULL,
  kind          TEXT NOT NULL,
  dedupe_key    TEXT NOT NULL,
  occurred_at   TEXT NOT NULL,
  source_ref    TEXT NOT NULL,
  line_ids_json TEXT NOT NULL DEFAULT '[]',
  amount_minor  INTEGER,
  command_id    TEXT NOT NULL,
  PRIMARY KEY (user_id, event_id),
  UNIQUE (user_id, order_id, dedupe_key),
  FOREIGN KEY (user_id, order_id) REFERENCES orders(user_id, order_id)
);

-- ---------------------------------------------------------------------------------------------
-- Product investigations (records OUTSIDE the wardrobe) and saved research
-- ---------------------------------------------------------------------------------------------

CREATE TABLE products (
  user_id      TEXT NOT NULL REFERENCES users(user_id),
  product_id   TEXT NOT NULL,
  version      INTEGER NOT NULL DEFAULT 1,
  url          TEXT,
  maker        TEXT,
  name         TEXT NOT NULL,
  product_code TEXT,
  note         TEXT,
  source_ref   TEXT,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  PRIMARY KEY (user_id, product_id)
);

CREATE TABLE product_observations (
  user_id        TEXT NOT NULL,
  observation_id TEXT NOT NULL,
  product_id     TEXT NOT NULL,
  observed_at    TEXT NOT NULL,
  checked_url    TEXT NOT NULL,
  availability   TEXT NOT NULL CHECK (availability IN ('available', 'unavailable', 'unknown')),
  size           TEXT,
  colour         TEXT,
  price_minor    INTEGER,
  currency       TEXT,
  country        TEXT,
  method         TEXT NOT NULL,
  completeness   TEXT NOT NULL,
  facts_json     TEXT NOT NULL DEFAULT '[]',
  missing_fields_json TEXT NOT NULL DEFAULT '[]',
  return_terms   TEXT,
  command_id     TEXT NOT NULL,
  PRIMARY KEY (user_id, observation_id),
  FOREIGN KEY (user_id, product_id) REFERENCES products(user_id, product_id)
);
CREATE INDEX product_observations_product ON product_observations(user_id, product_id, observed_at);

CREATE TABLE fit_assessments (
  user_id        TEXT NOT NULL,
  assessment_id  TEXT NOT NULL,
  product_id     TEXT NOT NULL,
  size_label     TEXT,
  verdict        TEXT NOT NULL,
  computation_json TEXT NOT NULL,
  uncertainties_json TEXT NOT NULL DEFAULT '[]',
  measurement_refs_json TEXT NOT NULL DEFAULT '[]',
  command_id     TEXT NOT NULL,
  created_at     TEXT NOT NULL,
  PRIMARY KEY (user_id, assessment_id),
  FOREIGN KEY (user_id, product_id) REFERENCES products(user_id, product_id)
);

CREATE TABLE research_notes (
  user_id          TEXT NOT NULL REFERENCES users(user_id),
  note_id          TEXT NOT NULL,
  version          INTEGER NOT NULL DEFAULT 1,
  topic            TEXT NOT NULL,
  body             TEXT NOT NULL,
  claims_json      TEXT NOT NULL DEFAULT '[]',
  garment_ids_json TEXT NOT NULL DEFAULT '[]',
  product_ids_json TEXT NOT NULL DEFAULT '[]',
  status           TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'forgotten')),
  command_id       TEXT NOT NULL,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  PRIMARY KEY (user_id, note_id)
);

-- ---------------------------------------------------------------------------------------------
-- Returns and exchanges
-- ---------------------------------------------------------------------------------------------

CREATE TABLE return_cases (
  user_id              TEXT NOT NULL REFERENCES users(user_id),
  case_id              TEXT NOT NULL,
  version              INTEGER NOT NULL DEFAULT 1,
  kind                 TEXT NOT NULL CHECK (kind IN ('return', 'exchange')),
  state                TEXT NOT NULL,
  order_id             TEXT,
  line_id              TEXT,
  garment_id           TEXT,
  quantity             INTEGER NOT NULL CHECK (quantity > 0),
  terms_json           TEXT,
  trigger_date         TEXT,
  deadline_status      TEXT NOT NULL CHECK (deadline_status IN ('established', 'unresolved')),
  deadline_at          TEXT,
  deadline_local_date  TEXT,
  deadline_timezone    TEXT,
  deadline_concerns    TEXT,
  deadline_reason      TEXT,
  next_action          TEXT,
  label_ref            TEXT,
  collection_preference TEXT,
  shipment_ref         TEXT,
  retailer_received_on TEXT,
  refund_expected_minor INTEGER,
  refund_received_minor INTEGER NOT NULL DEFAULT 0 CHECK (refund_received_minor >= 0),
  currency             TEXT,
  exchange_order_id    TEXT,
  exchange_line_id     TEXT,
  reason               TEXT,
  notes_json           TEXT NOT NULL DEFAULT '[]',
  created_at           TEXT NOT NULL,
  updated_at           TEXT NOT NULL,
  PRIMARY KEY (user_id, case_id),
  FOREIGN KEY (user_id, garment_id) REFERENCES garments(user_id, garment_id),
  FOREIGN KEY (user_id, order_id) REFERENCES orders(user_id, order_id)
);
CREATE INDEX return_cases_state ON return_cases(user_id, state);

-- ---------------------------------------------------------------------------------------------
-- Lifecycle projects (consignment, sale, tailoring, storage, disposal)
-- ---------------------------------------------------------------------------------------------

CREATE TABLE lifecycle_projects (
  user_id             TEXT NOT NULL REFERENCES users(user_id),
  project_id          TEXT NOT NULL,
  version             INTEGER NOT NULL DEFAULT 1,
  kind                TEXT NOT NULL,
  state               TEXT NOT NULL,
  title               TEXT NOT NULL,
  destination         TEXT,
  next_action         TEXT,
  details_json        TEXT NOT NULL DEFAULT '{}',
  authorizations_json TEXT NOT NULL DEFAULT '[]',
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL,
  PRIMARY KEY (user_id, project_id)
);

CREATE TABLE lifecycle_project_items (
  user_id        TEXT NOT NULL,
  project_id     TEXT NOT NULL,
  garment_id     TEXT NOT NULL,
  quantity       INTEGER NOT NULL CHECK (quantity > 0),
  state          TEXT NOT NULL DEFAULT 'included',
  proceeds_minor INTEGER,
  currency       TEXT,
  PRIMARY KEY (user_id, project_id, garment_id),
  FOREIGN KEY (user_id, project_id) REFERENCES lifecycle_projects(user_id, project_id),
  FOREIGN KEY (user_id, garment_id) REFERENCES garments(user_id, garment_id)
);

CREATE TABLE lifecycle_events (
  user_id      TEXT NOT NULL,
  event_id     TEXT NOT NULL,
  project_id   TEXT NOT NULL,
  kind         TEXT NOT NULL,
  detail_json  TEXT NOT NULL DEFAULT '{}',
  external_operation_key TEXT,
  occurred_at  TEXT NOT NULL,
  command_id   TEXT NOT NULL,
  PRIMARY KEY (user_id, event_id),
  FOREIGN KEY (user_id, project_id) REFERENCES lifecycle_projects(user_id, project_id)
);
CREATE INDEX lifecycle_events_project ON lifecycle_events(user_id, project_id, occurred_at);
CREATE UNIQUE INDEX lifecycle_events_external ON lifecycle_events(user_id, project_id, kind, external_operation_key) WHERE external_operation_key IS NOT NULL;

-- ---------------------------------------------------------------------------------------------
-- Optional comfort feedback
-- ---------------------------------------------------------------------------------------------

CREATE TABLE comfort_feedback (
  user_id          TEXT NOT NULL REFERENCES users(user_id),
  feedback_id      TEXT NOT NULL,
  text             TEXT NOT NULL,
  kind             TEXT NOT NULL,
  pain             INTEGER NOT NULL DEFAULT 0,
  wearing_date     TEXT,
  activity         TEXT,
  layer            TEXT,
  conditions_json  TEXT NOT NULL DEFAULT '{}',
  scope            TEXT,
  source_ref       TEXT,
  status           TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'retracted', 'forgotten')),
  command_id       TEXT NOT NULL,
  created_at       TEXT NOT NULL,
  PRIMARY KEY (user_id, feedback_id)
);

CREATE TABLE comfort_feedback_garments (
  user_id     TEXT NOT NULL,
  feedback_id TEXT NOT NULL,
  garment_id  TEXT NOT NULL,
  PRIMARY KEY (user_id, feedback_id, garment_id),
  FOREIGN KEY (user_id, feedback_id) REFERENCES comfort_feedback(user_id, feedback_id),
  FOREIGN KEY (user_id, garment_id) REFERENCES garments(user_id, garment_id)
);
CREATE INDEX comfort_feedback_garment ON comfort_feedback_garments(user_id, garment_id);

-- ---------------------------------------------------------------------------------------------
-- Inference accounting: reservations before dispatch, settlement against reported usage
-- ---------------------------------------------------------------------------------------------

CREATE TABLE inference_reservations (
  user_id           TEXT NOT NULL REFERENCES users(user_id),
  reservation_id    TEXT NOT NULL,
  run_id            TEXT NOT NULL,
  task              TEXT NOT NULL,
  budget_class      TEXT NOT NULL,
  profile_id        TEXT NOT NULL,
  attempt           INTEGER NOT NULL,
  budget_day        TEXT NOT NULL,
  reserved_microusd INTEGER NOT NULL CHECK (reserved_microusd >= 0),
  actual_microusd   INTEGER NOT NULL DEFAULT 0 CHECK (actual_microusd >= 0),
  state             TEXT NOT NULL CHECK (state IN ('reserved', 'settled', 'released', 'uncertain')),
  parent_kind       TEXT NOT NULL,
  parent_id         TEXT NOT NULL,
  prompt_version    TEXT,
  gateway_id        TEXT NOT NULL,
  input_tokens      INTEGER,
  output_tokens     INTEGER,
  resolved_model    TEXT,
  error_class       TEXT,
  created_at        TEXT NOT NULL,
  settled_at        TEXT,
  PRIMARY KEY (user_id, reservation_id)
);
CREATE INDEX inference_reservations_budget ON inference_reservations(user_id, budget_class, budget_day, state);
CREATE INDEX inference_reservations_run ON inference_reservations(user_id, run_id);

-- Capability and billing probes are facts about the environment's Gateway routes, not personal data.
CREATE TABLE model_probes (
  gateway_id     TEXT NOT NULL,
  profile_id     TEXT NOT NULL,
  operation      TEXT NOT NULL,
  result         TEXT NOT NULL CHECK (result IN ('passed', 'failed')),
  billing        TEXT NOT NULL CHECK (billing IN ('unified_billing', 'ineligible')),
  reason         TEXT,
  resolved_model TEXT,
  probed_at      TEXT NOT NULL,
  PRIMARY KEY (gateway_id, profile_id, operation)
);

-- Circuit breaker state per Gateway route (environment-level).
CREATE TABLE model_breakers (
  gateway_id  TEXT NOT NULL,
  profile_id  TEXT NOT NULL,
  failures    INTEGER NOT NULL DEFAULT 0,
  state       TEXT NOT NULL DEFAULT 'closed' CHECK (state IN ('closed', 'open', 'half_open')),
  opened_at   TEXT,
  updated_at  TEXT NOT NULL,
  PRIMARY KEY (gateway_id, profile_id)
);

-- ---------------------------------------------------------------------------------------------
-- Outbound connections (registry only: no credentials are stored here)
-- ---------------------------------------------------------------------------------------------

CREATE TABLE connections (
  user_id            TEXT NOT NULL REFERENCES users(user_id),
  connection_id      TEXT NOT NULL,
  version            INTEGER NOT NULL DEFAULT 1,
  kind               TEXT NOT NULL,
  label              TEXT NOT NULL,
  endpoint           TEXT NOT NULL,
  namespace          TEXT NOT NULL,
  secret_ref         TEXT,
  scopes_json        TEXT NOT NULL DEFAULT '[]',
  status             TEXT NOT NULL CHECK (status IN ('registered', 'connected', 'needs_reauthorization', 'revoked')),
  status_reason      TEXT,
  protocol_version   TEXT,
  schema_digest      TEXT,
  tools_json         TEXT NOT NULL DEFAULT '[]',
  enabled_groups_json TEXT NOT NULL DEFAULT '[]',
  last_discovery_at  TEXT,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL,
  PRIMARY KEY (user_id, connection_id),
  UNIQUE (user_id, namespace)
);

-- ---------------------------------------------------------------------------------------------
-- Background jobs with deduplicated result delivery
-- ---------------------------------------------------------------------------------------------

CREATE TABLE assistant_jobs (
  user_id          TEXT NOT NULL REFERENCES users(user_id),
  job_id           TEXT NOT NULL,
  version          INTEGER NOT NULL DEFAULT 1,
  kind             TEXT NOT NULL,
  state            TEXT NOT NULL CHECK (state IN ('queued', 'running', 'completed', 'failed', 'cancelled')),
  title            TEXT NOT NULL,
  params_json      TEXT NOT NULL DEFAULT '{}',
  priority         INTEGER NOT NULL DEFAULT 5,
  progress_json    TEXT NOT NULL DEFAULT '{}',
  coverage_json    TEXT,
  result_ref       TEXT,
  unresolved_reason TEXT,
  committed_command_ids_json TEXT NOT NULL DEFAULT '[]',
  delivery_id      TEXT NOT NULL,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  PRIMARY KEY (user_id, job_id),
  UNIQUE (user_id, delivery_id)
);
CREATE INDEX assistant_jobs_state ON assistant_jobs(user_id, state, priority);
