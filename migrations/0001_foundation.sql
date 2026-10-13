-- Garderobe base schema (foundation workstream).
--
-- Fresh logical schema from specification sections 5, 8 and 15. Rules that hold everywhere:
--   * every personal record carries user_id; primary keys are owner-qualified and child tables use
--     compound foreign keys (user_id, x_id) so a row can never reference another owner's record;
--   * quantities never go negative (CHECK); the stock journal is append-only and balances are a
--     materialized replay of it;
--   * a command, its receipt, its domain writes and its effect/outbox rows commit in one D1 batch whose
--     first statement is a CHECK-constrained precondition row (command_preconditions.ok = 1).
--
-- Migration numbering (one shared directory, no file is edited after it lands):
--   0001-0099 foundation          0100-0199 daily-service        0200-0299 assistant
--   0300-0399 api-mcp-identity    0400-0499 visual-wardrobe      0500-0599 ios (server-side support)
--   0600-0699 deployment          0700-0799 simulation/tests

PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------------------------------------
-- Owners and identity
-- ---------------------------------------------------------------------------------------------
CREATE TABLE users (
  user_id       TEXT PRIMARY KEY,
  display_name  TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  is_synthetic  INTEGER NOT NULL DEFAULT 0 CHECK (is_synthetic IN (0, 1)),
  created_at    TEXT NOT NULL
);

-- Email is a display attribute only; (issuer, subject) is the identity key.
CREATE TABLE auth_identities (
  user_id       TEXT NOT NULL REFERENCES users(user_id),
  issuer        TEXT NOT NULL,
  subject       TEXT NOT NULL,
  display_email TEXT,
  linked_at     TEXT NOT NULL,
  unlinked_at   TEXT,
  PRIMARY KEY (issuer, subject)
);
CREATE INDEX auth_identities_user ON auth_identities(user_id);

CREATE TABLE owner_settings (
  user_id       TEXT PRIMARY KEY REFERENCES users(user_id),
  version       INTEGER NOT NULL CHECK (version >= 1),
  settings_json TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

CREATE TABLE owner_settings_versions (
  user_id       TEXT NOT NULL REFERENCES users(user_id),
  version       INTEGER NOT NULL,
  settings_json TEXT NOT NULL,
  command_id    TEXT,
  created_at    TEXT NOT NULL,
  PRIMARY KEY (user_id, version)
);

-- Monotonic per-owner revisions used for optimistic checks (composition re-validation, caches).
CREATE TABLE owner_state (
  user_id           TEXT PRIMARY KEY REFERENCES users(user_id),
  wardrobe_revision INTEGER NOT NULL DEFAULT 0 CHECK (wardrobe_revision >= 0),
  style_revision    INTEGER NOT NULL DEFAULT 0 CHECK (style_revision >= 0)
);

-- ---------------------------------------------------------------------------------------------
-- Commands, receipts, action intents, effects, outbox
-- ---------------------------------------------------------------------------------------------

-- First statement of every command batch inserts here; a false predicate raises a real SQLite
-- constraint error and rolls back the whole batch. Rows are deleted by the last statement.
CREATE TABLE command_preconditions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  command_id  TEXT NOT NULL,
  label       TEXT NOT NULL,
  ok          INTEGER NOT NULL,
  CONSTRAINT garderobe_precondition_failed CHECK (ok = 1)
);

CREATE TABLE commands (
  user_id              TEXT NOT NULL REFERENCES users(user_id),
  command_id           TEXT NOT NULL,
  idempotency_key      TEXT NOT NULL,
  type                 TEXT NOT NULL,
  request_hash         TEXT NOT NULL,
  payload_json         TEXT NOT NULL,
  channel              TEXT NOT NULL,
  actor                TEXT NOT NULL,
  authorization_basis  TEXT NOT NULL,
  source_json          TEXT NOT NULL,
  occurred_at          TEXT NOT NULL,
  recorded_at          TEXT NOT NULL,
  outcome              TEXT NOT NULL CHECK (outcome IN ('committed', 'merged', 'noop')),
  receipt_json         TEXT NOT NULL,
  undo_json            TEXT,
  undoes_command_id    TEXT,
  undone_by_command_id TEXT,
  PRIMARY KEY (user_id, command_id),
  CONSTRAINT garderobe_idempotency_key_unique UNIQUE (user_id, idempotency_key)
);
CREATE INDEX commands_recorded ON commands(user_id, recorded_at);
CREATE INDEX commands_type ON commands(user_id, type, recorded_at);

-- Which entities a command touched, for item history and receipt lookup.
CREATE TABLE command_entities (
  user_id     TEXT NOT NULL,
  command_id  TEXT NOT NULL,
  kind        TEXT NOT NULL,
  entity_id   TEXT NOT NULL,
  version     INTEGER NOT NULL,
  PRIMARY KEY (user_id, command_id, kind, entity_id),
  FOREIGN KEY (user_id, command_id) REFERENCES commands(user_id, command_id)
);
CREATE INDEX command_entities_entity ON command_entities(user_id, kind, entity_id);

-- Durable action intents: a proposed mutation registered before any effect is dispatched, so a
-- recovered or resampled model turn resolves to the same command (specification section 8).
CREATE TABLE action_intents (
  user_id                TEXT NOT NULL REFERENCES users(user_id),
  action_id              TEXT NOT NULL,
  parent_kind            TEXT NOT NULL,
  parent_id              TEXT NOT NULL,
  operation              TEXT NOT NULL,
  targets_json           TEXT NOT NULL,
  effect_hash            TEXT NOT NULL,
  effect_json            TEXT NOT NULL,
  expected_versions_json TEXT NOT NULL,
  state                  TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'committed', 'abandoned')),
  command_id             TEXT,
  created_at             TEXT NOT NULL,
  updated_at             TEXT NOT NULL,
  PRIMARY KEY (user_id, action_id),
  UNIQUE (user_id, parent_kind, parent_id, effect_hash)
);

-- Durable external effect records (Calendar projection, notification, image work...). Written in
-- the same batch as the command; an external write is only `projected` after read-back verification.
CREATE TABLE effects (
  user_id          TEXT NOT NULL REFERENCES users(user_id),
  effect_id        TEXT NOT NULL,
  command_id       TEXT NOT NULL,
  kind             TEXT NOT NULL,
  target_key       TEXT NOT NULL,
  operation_key    TEXT NOT NULL,
  desired_revision INTEGER NOT NULL DEFAULT 0,
  payload_json     TEXT NOT NULL,
  state            TEXT NOT NULL DEFAULT 'pending'
                   CHECK (state IN ('pending', 'in_progress', 'projected', 'failed', 'superseded', 'cancelled')),
  attempts         INTEGER NOT NULL DEFAULT 0,
  last_error       TEXT,
  available_at     TEXT NOT NULL,
  claimed_until    TEXT,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  PRIMARY KEY (user_id, effect_id),
  UNIQUE (user_id, operation_key),
  FOREIGN KEY (user_id, command_id) REFERENCES commands(user_id, command_id)
);
CREATE INDEX effects_due ON effects(state, available_at);
CREATE INDEX effects_target ON effects(user_id, kind, target_key, desired_revision);

-- Transactional projection outbox for derived stores (AI Search indexing, caches). Carries IDs and
-- revisions, never whole private documents.
CREATE TABLE outbox (
  seq          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      TEXT NOT NULL REFERENCES users(user_id),
  topic        TEXT NOT NULL,
  entity_kind  TEXT NOT NULL,
  entity_id    TEXT NOT NULL,
  revision     INTEGER NOT NULL,
  payload_json TEXT NOT NULL,
  command_id   TEXT,
  state        TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'dispatched', 'acknowledged')),
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);
CREATE INDEX outbox_pending ON outbox(state, seq);
CREATE INDEX outbox_user ON outbox(user_id, topic, seq);

-- ---------------------------------------------------------------------------------------------
-- Garments, aliases, facts
-- ---------------------------------------------------------------------------------------------
CREATE TABLE garments (
  user_id            TEXT NOT NULL REFERENCES users(user_id),
  garment_id         TEXT NOT NULL,
  version            INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  name               TEXT NOT NULL,
  category           TEXT NOT NULL,
  roles_json         TEXT NOT NULL,
  maker              TEXT,
  product            TEXT,
  fabric             TEXT,
  colour             TEXT,
  pattern            TEXT,
  size               TEXT,
  care_channel       TEXT NOT NULL CHECK (care_channel IN ('service', 'handwash', 'none')),
  acquisition        TEXT NOT NULL CHECK (acquisition IN ('incoming', 'owned', 'disposed')),
  planning_policy    TEXT NOT NULL DEFAULT 'normal' CHECK (planning_policy IN ('normal', 'occasional', 'excluded')),
  planning_reason    TEXT,
  condition          TEXT,
  season_note        TEXT,
  thermal_json       TEXT,
  attributes_json    TEXT NOT NULL DEFAULT '{}',
  is_synthetic       INTEGER NOT NULL DEFAULT 0 CHECK (is_synthetic IN (0, 1)),
  merged_into        TEXT,
  removed_reason     TEXT,
  wear_logging_since TEXT,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL,
  PRIMARY KEY (user_id, garment_id),
  FOREIGN KEY (user_id, merged_into) REFERENCES garments(user_id, garment_id)
);
CREATE INDEX garments_category ON garments(user_id, category);

CREATE TABLE garment_aliases (
  user_id       TEXT NOT NULL,
  alias_id      TEXT NOT NULL,
  garment_id    TEXT NOT NULL,
  phrase        TEXT NOT NULL,
  normalized    TEXT NOT NULL,
  kind          TEXT NOT NULL CHECK (kind IN ('owner_name', 'maker_name', 'code', 'import', 'merged')),
  created_at    TEXT NOT NULL,
  removed_at    TEXT,
  PRIMARY KEY (user_id, alias_id),
  FOREIGN KEY (user_id, garment_id) REFERENCES garments(user_id, garment_id)
);
CREATE INDEX garment_aliases_lookup ON garment_aliases(user_id, normalized);
CREATE INDEX garment_aliases_garment ON garment_aliases(user_id, garment_id);

-- Dated assertions with source, scope and supersession. A correction supersedes; it never erases.
CREATE TABLE garment_facts (
  user_id       TEXT NOT NULL,
  fact_id       TEXT NOT NULL,
  garment_id    TEXT NOT NULL,
  attribute     TEXT NOT NULL,
  value_json    TEXT NOT NULL,
  source_json   TEXT NOT NULL,
  scope         TEXT,
  superseded_by TEXT,
  command_id    TEXT,
  recorded_at   TEXT NOT NULL,
  PRIMARY KEY (user_id, fact_id),
  FOREIGN KEY (user_id, garment_id) REFERENCES garments(user_id, garment_id)
);
CREATE INDEX garment_facts_garment ON garment_facts(user_id, garment_id, attribute);

-- ---------------------------------------------------------------------------------------------
-- Stock journal and materialized balances
-- ---------------------------------------------------------------------------------------------

-- Append-only journal. Balances are the deterministic replay of a garment's events plus the
-- owner-level events (garment_id NULL: weekly resets, cycle exceptions) in (occurred_at, seq) order.
-- Undo/amend never deletes: it sets voided_by_command_id through a compensating command.
CREATE TABLE stock_events (
  seq                  INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id              TEXT NOT NULL REFERENCES users(user_id),
  event_id             TEXT NOT NULL,
  garment_id           TEXT,
  kind                 TEXT NOT NULL,
  payload_json         TEXT NOT NULL,
  basis                TEXT NOT NULL CHECK (basis IN ('observed', 'inferred', 'import', 'reconciliation')),
  occurred_at          TEXT NOT NULL,
  recorded_at          TEXT NOT NULL,
  command_id           TEXT NOT NULL,
  voided_by_command_id TEXT,
  UNIQUE (user_id, event_id),
  FOREIGN KEY (user_id, garment_id) REFERENCES garments(user_id, garment_id),
  FOREIGN KEY (user_id, command_id) REFERENCES commands(user_id, command_id)
);
CREATE INDEX stock_events_garment ON stock_events(user_id, garment_id, occurred_at, seq);
CREATE INDEX stock_events_command ON stock_events(user_id, command_id);

CREATE TABLE stock_balances (
  user_id     TEXT NOT NULL,
  garment_id  TEXT NOT NULL,
  bucket      TEXT NOT NULL CHECK (bucket IN ('incoming', 'clean', 'dirty', 'service', 'storage', 'tailor', 'trip', 'gone')),
  ref         TEXT NOT NULL DEFAULT '',
  quantity    INTEGER NOT NULL CHECK (quantity >= 0),
  held        INTEGER NOT NULL DEFAULT 0 CHECK (held IN (0, 1)),
  PRIMARY KEY (user_id, garment_id, bucket, ref),
  FOREIGN KEY (user_id, garment_id) REFERENCES garments(user_id, garment_id)
);

-- ---------------------------------------------------------------------------------------------
-- Restrictions
-- ---------------------------------------------------------------------------------------------
CREATE TABLE restrictions (
  user_id             TEXT NOT NULL REFERENCES users(user_id),
  restriction_id      TEXT NOT NULL,
  kind                TEXT NOT NULL,
  scope_json          TEXT NOT NULL,
  reason              TEXT NOT NULL,
  starts_at           TEXT NOT NULL,
  expected_end        TEXT,
  required_evidence   TEXT NOT NULL,
  status              TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'resolved')),
  resolved_at         TEXT,
  resolution_json     TEXT,
  source_json         TEXT NOT NULL,
  command_id          TEXT NOT NULL,
  resolved_command_id TEXT,
  PRIMARY KEY (user_id, restriction_id)
);
CREATE INDEX restrictions_active ON restrictions(user_id, status);

-- ---------------------------------------------------------------------------------------------
-- Wear
-- ---------------------------------------------------------------------------------------------

-- Every report is retained with its provenance.
CREATE TABLE wear_observations (
  user_id              TEXT NOT NULL,
  observation_id       TEXT NOT NULL,
  garment_id           TEXT NOT NULL,
  wearing_date         TEXT NOT NULL,
  occurred_at          TEXT NOT NULL,
  reported_at          TEXT NOT NULL,
  timezone             TEXT NOT NULL,
  channel              TEXT NOT NULL,
  client_submission_id TEXT,
  segment              TEXT,
  note                 TEXT,
  status               TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'retracted')),
  command_id           TEXT NOT NULL,
  retracted_by_command_id TEXT,
  original_garment_id  TEXT,
  PRIMARY KEY (user_id, observation_id),
  FOREIGN KEY (user_id, garment_id) REFERENCES garments(user_id, garment_id),
  FOREIGN KEY (user_id, command_id) REFERENCES commands(user_id, command_id)
);
CREATE INDEX wear_observations_key ON wear_observations(user_id, garment_id, wearing_date);
CREATE INDEX wear_observations_date ON wear_observations(user_id, wearing_date);

-- The counted wear. The primary key IS the counted-wear key: one row per owner, garment, wearing date.
CREATE TABLE daily_wears (
  user_id           TEXT NOT NULL,
  garment_id        TEXT NOT NULL,
  wearing_date      TEXT NOT NULL,
  observation_count INTEGER NOT NULL CHECK (observation_count >= 0),
  status            TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'retracted')),
  stock_event_id    TEXT,
  first_reported_at TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  PRIMARY KEY (user_id, garment_id, wearing_date),
  FOREIGN KEY (user_id, garment_id) REFERENCES garments(user_id, garment_id)
);
CREATE INDEX daily_wears_date ON daily_wears(user_id, wearing_date);

-- ---------------------------------------------------------------------------------------------
-- Laundry
-- ---------------------------------------------------------------------------------------------
CREATE TABLE laundry_batches (
  user_id       TEXT NOT NULL REFERENCES users(user_id),
  batch_id      TEXT NOT NULL,
  channel       TEXT NOT NULL CHECK (channel IN ('service', 'handwash')),
  status        TEXT NOT NULL CHECK (status IN ('collected', 'returned', 'partially_returned', 'inferred_returned')),
  picked_up_at  TEXT NOT NULL,
  returned_at   TEXT,
  return_basis  TEXT CHECK (return_basis IS NULL OR return_basis IN ('observed', 'inferred')),
  command_id    TEXT NOT NULL,
  PRIMARY KEY (user_id, batch_id)
);

CREATE TABLE laundry_batch_items (
  user_id            TEXT NOT NULL,
  batch_id           TEXT NOT NULL,
  garment_id         TEXT NOT NULL,
  quantity           INTEGER NOT NULL CHECK (quantity > 0),
  returned_quantity  INTEGER NOT NULL DEFAULT 0 CHECK (returned_quantity >= 0),
  still_away         INTEGER NOT NULL DEFAULT 0 CHECK (still_away >= 0),
  PRIMARY KEY (user_id, batch_id, garment_id),
  FOREIGN KEY (user_id, batch_id) REFERENCES laundry_batches(user_id, batch_id),
  FOREIGN KEY (user_id, garment_id) REFERENCES garments(user_id, garment_id),
  CHECK (returned_quantity + still_away <= quantity)
);

-- One row per owner, channel and cycle: the weekly reset is applied once, even after missed runs.
CREATE TABLE laundry_cycles (
  user_id      TEXT NOT NULL REFERENCES users(user_id),
  channel      TEXT NOT NULL CHECK (channel IN ('service', 'handwash')),
  cycle_key    TEXT NOT NULL,
  cutoff_at    TEXT NOT NULL,
  baseline_at  TEXT NOT NULL,
  applied_at   TEXT NOT NULL,
  command_id   TEXT NOT NULL,
  PRIMARY KEY (user_id, channel, cycle_key)
);

CREATE TABLE laundry_exceptions (
  user_id       TEXT NOT NULL REFERENCES users(user_id),
  exception_id  TEXT NOT NULL,
  kind          TEXT NOT NULL CHECK (kind IN ('missed_return', 'delayed', 'still_away', 'lost')),
  garment_id    TEXT,
  batch_id      TEXT,
  cycle_key     TEXT,
  quantity      INTEGER NOT NULL DEFAULT 1 CHECK (quantity > 0),
  occurred_at   TEXT NOT NULL,
  reported_at   TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'resolved')),
  resolved_at   TEXT,
  note          TEXT,
  command_id    TEXT NOT NULL,
  PRIMARY KEY (user_id, exception_id),
  FOREIGN KEY (user_id, garment_id) REFERENCES garments(user_id, garment_id)
);

-- ---------------------------------------------------------------------------------------------
-- Selection-probability exposures (published option sets whose wear is not yet observed)
-- ---------------------------------------------------------------------------------------------
CREATE TABLE exposure_sets (
  user_id            TEXT NOT NULL REFERENCES users(user_id),
  exposure_id        TEXT NOT NULL,
  local_date         TEXT NOT NULL,
  source_kind        TEXT NOT NULL,
  source_ref         TEXT NOT NULL,
  option_count       INTEGER NOT NULL CHECK (option_count > 0),
  p_use              REAL CHECK (p_use IS NULL OR (p_use >= 0 AND p_use <= 1)),
  selected_option_id TEXT,
  chosen_alternatives_json TEXT NOT NULL DEFAULT '[]',
  status             TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'selected', 'resolved_worn', 'superseded')),
  command_id         TEXT NOT NULL,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL,
  PRIMARY KEY (user_id, exposure_id)
);
CREATE INDEX exposure_sets_date ON exposure_sets(user_id, local_date, status);

CREATE TABLE exposure_items (
  user_id      TEXT NOT NULL,
  exposure_id  TEXT NOT NULL,
  option_id    TEXT NOT NULL,
  garment_id   TEXT NOT NULL,
  alt_group    INTEGER NOT NULL DEFAULT 0,  -- 0 = certain if the option is worn; >0 = alternative group number
  PRIMARY KEY (user_id, exposure_id, option_id, garment_id),
  FOREIGN KEY (user_id, exposure_id) REFERENCES exposure_sets(user_id, exposure_id),
  FOREIGN KEY (user_id, garment_id) REFERENCES garments(user_id, garment_id)
);

-- ---------------------------------------------------------------------------------------------
-- Style documents, amendments, rules, directions, briefs, measurements
-- ---------------------------------------------------------------------------------------------
CREATE TABLE style_documents (
  user_id        TEXT NOT NULL REFERENCES users(user_id),
  document_id    TEXT NOT NULL,
  version        INTEGER NOT NULL CHECK (version >= 1),
  title          TEXT NOT NULL,
  content        TEXT NOT NULL,
  content_sha256 TEXT NOT NULL,
  byte_length    INTEGER NOT NULL,
  status         TEXT NOT NULL CHECK (status IN ('active', 'superseded')),
  source_json    TEXT NOT NULL,
  command_id     TEXT NOT NULL,
  created_at     TEXT NOT NULL,
  PRIMARY KEY (user_id, document_id, version)
);

CREATE TABLE style_amendments (
  user_id          TEXT NOT NULL REFERENCES users(user_id),
  amendment_id     TEXT NOT NULL,
  document_id      TEXT NOT NULL,
  based_on_version INTEGER NOT NULL,
  text             TEXT NOT NULL,
  kind             TEXT NOT NULL,
  status           TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'incorporated', 'retired')),
  source_json      TEXT NOT NULL,
  command_id       TEXT NOT NULL,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  PRIMARY KEY (user_id, amendment_id),
  FOREIGN KEY (user_id, document_id, based_on_version) REFERENCES style_documents(user_id, document_id, version)
);

CREATE TABLE style_rules (
  user_id        TEXT NOT NULL REFERENCES users(user_id),
  rule_id        TEXT NOT NULL,
  version        INTEGER NOT NULL CHECK (version >= 1),
  key            TEXT NOT NULL,
  kind           TEXT NOT NULL CHECK (kind IN ('hard', 'soft')),
  status         TEXT NOT NULL CHECK (status IN ('active', 'pending_reconciliation', 'dormant', 'retired')),
  params_json    TEXT NOT NULL,
  interpretation TEXT NOT NULL,
  passages_json  TEXT NOT NULL,
  origin         TEXT NOT NULL,
  is_current     INTEGER NOT NULL DEFAULT 1 CHECK (is_current IN (0, 1)),
  command_id     TEXT NOT NULL,
  created_at     TEXT NOT NULL,
  PRIMARY KEY (user_id, rule_id, version)
);
CREATE UNIQUE INDEX style_rules_current_key ON style_rules(user_id, key) WHERE is_current = 1;

CREATE TABLE standing_directions (
  user_id      TEXT NOT NULL REFERENCES users(user_id),
  direction_id TEXT NOT NULL,
  version      INTEGER NOT NULL DEFAULT 1,
  text         TEXT NOT NULL,
  scope        TEXT,
  check_key    TEXT,
  status       TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'retired')),
  source_json  TEXT NOT NULL,
  command_id   TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  PRIMARY KEY (user_id, direction_id)
);

CREATE TABLE temporary_briefs (
  user_id     TEXT NOT NULL REFERENCES users(user_id),
  brief_id    TEXT NOT NULL,
  local_date  TEXT NOT NULL,
  text        TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'retired')),
  source_json TEXT NOT NULL,
  command_id  TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  PRIMARY KEY (user_id, brief_id)
);
CREATE INDEX temporary_briefs_date ON temporary_briefs(user_id, local_date, status);

CREATE TABLE measurements (
  user_id        TEXT NOT NULL REFERENCES users(user_id),
  measurement_id TEXT NOT NULL,
  subject        TEXT NOT NULL CHECK (subject IN ('body', 'garment')),
  garment_id     TEXT,
  key            TEXT NOT NULL,
  value          REAL NOT NULL,
  unit           TEXT NOT NULL,
  convention     TEXT,
  qualifier      TEXT,
  measured_on    TEXT,
  source_json    TEXT NOT NULL,
  passage_json   TEXT,
  superseded_by  TEXT,
  command_id     TEXT NOT NULL,
  created_at     TEXT NOT NULL,
  PRIMARY KEY (user_id, measurement_id),
  FOREIGN KEY (user_id, garment_id) REFERENCES garments(user_id, garment_id)
);
CREATE INDEX measurements_key ON measurements(user_id, subject, key);

CREATE TABLE size_experiences (
  user_id            TEXT NOT NULL REFERENCES users(user_id),
  size_experience_id TEXT NOT NULL,
  maker              TEXT NOT NULL,
  product_family     TEXT,
  size_label         TEXT NOT NULL,
  note               TEXT,
  noted_on           TEXT,
  passage_json       TEXT,
  command_id         TEXT NOT NULL,
  created_at         TEXT NOT NULL,
  PRIMARY KEY (user_id, size_experience_id)
);

-- ---------------------------------------------------------------------------------------------
-- Import bookkeeping
-- ---------------------------------------------------------------------------------------------
CREATE TABLE import_runs (
  user_id       TEXT NOT NULL REFERENCES users(user_id),
  import_run_id TEXT NOT NULL,
  source_name   TEXT NOT NULL,
  source_sha256 TEXT NOT NULL,
  source_bytes  INTEGER NOT NULL,
  importer      TEXT NOT NULL,
  summary_json  TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  PRIMARY KEY (user_id, import_run_id),
  UNIQUE (user_id, source_name, source_sha256)
);

-- Every source row is accounted for: imported, merged (with its mapping), held, or not a data row.
CREATE TABLE import_refs (
  user_id       TEXT NOT NULL,
  import_run_id TEXT NOT NULL,
  source_row    INTEGER NOT NULL,
  source_key    TEXT NOT NULL,
  disposition   TEXT NOT NULL CHECK (disposition IN ('imported', 'merged', 'held', 'not_a_data_row')),
  garment_id    TEXT,
  reason        TEXT NOT NULL,
  raw_json      TEXT NOT NULL,
  PRIMARY KEY (user_id, import_run_id, source_row),
  FOREIGN KEY (user_id, import_run_id) REFERENCES import_runs(user_id, import_run_id),
  FOREIGN KEY (user_id, garment_id) REFERENCES garments(user_id, garment_id)
);

CREATE TABLE migration_issues (
  user_id       TEXT NOT NULL,
  issue_id      TEXT NOT NULL,
  import_run_id TEXT NOT NULL,
  kind          TEXT NOT NULL,
  severity      TEXT NOT NULL CHECK (severity IN ('info', 'conflict', 'needs_owner')),
  detail        TEXT NOT NULL,
  garment_id    TEXT,
  source_rows_json TEXT NOT NULL DEFAULT '[]',
  status        TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
  PRIMARY KEY (user_id, issue_id),
  FOREIGN KEY (user_id, import_run_id) REFERENCES import_runs(user_id, import_run_id)
);
