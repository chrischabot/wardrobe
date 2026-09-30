-- Garderobe fresh schema, migration 0001.
-- Owned by the foundation workstream. Later workstreams add new numbered migrations; never edit this file.
--
-- Conventions
--  * Every private row carries user_id; primary keys and unique keys are owner-qualified and
--    relationships use compound foreign keys (user_id, x_id) so a row can never point at another
--    user's record.
--  * Timestamps are UTC ISO-8601 text; local dates are YYYY-MM-DD text with an IANA timezone.
--  * Mutable domain rows carry an integer version used by expected-version preconditions.
--  * Receipts, observations and movements are never deleted; corrections supersede or void them.
--  * D1 enforces foreign keys by default.

-- ---------------------------------------------------------------- identity and settings
CREATE TABLE users (
  user_id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  created_at TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE auth_identities (
  user_id TEXT NOT NULL REFERENCES users(user_id),
  identity_id TEXT NOT NULL,
  issuer TEXT NOT NULL,
  subject TEXT NOT NULL,
  email TEXT, -- display/contact only; never a key
  linked_at TEXT NOT NULL,
  unlinked_at TEXT,
  PRIMARY KEY (user_id, identity_id),
  UNIQUE (issuer, subject)
);

CREATE TABLE owner_settings (
  user_id TEXT PRIMARY KEY REFERENCES users(user_id),
  home_location_label TEXT NOT NULL,
  home_latitude REAL,
  home_longitude REAL,
  timezone TEXT NOT NULL DEFAULT 'Europe/London',
  delivery_time TEXT NOT NULL DEFAULT '07:00',
  daily_option_count INTEGER NOT NULL DEFAULT 5 CHECK (daily_option_count BETWEEN 3 AND 5),
  laundry_routine_json TEXT NOT NULL,
  estimator_params_json TEXT,
  model_profiles_json TEXT NOT NULL DEFAULT '{}',
  budget_json TEXT NOT NULL DEFAULT '{}',
  wear_logging_since TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL
);

CREATE TABLE owner_settings_history (
  user_id TEXT NOT NULL REFERENCES users(user_id),
  version INTEGER NOT NULL,
  body_json TEXT NOT NULL,
  command_id TEXT,
  changed_at TEXT NOT NULL,
  PRIMARY KEY (user_id, version)
);

-- ---------------------------------------------------------------- garments, aliases, facts
CREATE TABLE garments (
  user_id TEXT NOT NULL REFERENCES users(user_id),
  garment_id TEXT NOT NULL,
  name TEXT NOT NULL,
  category TEXT NOT NULL,
  roles_json TEXT NOT NULL,
  maker TEXT,
  product_name TEXT,
  product_code TEXT,
  fabric TEXT,
  color TEXT,
  color_family TEXT,
  pattern TEXT,
  size_label TEXT,
  care_channel TEXT NOT NULL CHECK (care_channel IN ('service', 'hand_wash', 'dry_clean', 'none')),
  laundry_policy TEXT NOT NULL CHECK (laundry_policy IN ('per_wear', 'single_wear_day', 'multi_wear', 'never')),
  tracking TEXT NOT NULL DEFAULT 'unit' CHECK (tracking IN ('unit', 'anonymous_quantity')),
  acquisition TEXT NOT NULL CHECK (acquisition IN ('incoming', 'owned', 'disposed')),
  disposal_reason TEXT,
  planning_policy TEXT NOT NULL DEFAULT 'normal' CHECK (planning_policy IN ('normal', 'occasional', 'excluded')),
  condition TEXT NOT NULL DEFAULT 'good',
  location TEXT NOT NULL DEFAULT 'home',
  location_detail TEXT,
  attributes_json TEXT NOT NULL DEFAULT '{}',
  notes TEXT,
  wear_logging_since TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (user_id, garment_id),
  -- a garment that never acquires laundry state cannot be configured with a laundry channel
  CHECK (laundry_policy <> 'never' OR care_channel = 'none')
);
CREATE INDEX garments_by_category ON garments (user_id, category);

CREATE TABLE garment_aliases (
  user_id TEXT NOT NULL,
  alias_id TEXT NOT NULL,
  garment_id TEXT NOT NULL,
  phrase TEXT NOT NULL,
  phrase_norm TEXT NOT NULL,
  kind TEXT NOT NULL,
  source TEXT,
  created_at TEXT NOT NULL,
  retired_at TEXT,
  PRIMARY KEY (user_id, alias_id),
  UNIQUE (user_id, garment_id, phrase_norm),
  FOREIGN KEY (user_id, garment_id) REFERENCES garments (user_id, garment_id)
);
CREATE INDEX aliases_by_phrase ON garment_aliases (user_id, phrase_norm);

CREATE TABLE garment_facts (
  user_id TEXT NOT NULL,
  fact_id TEXT NOT NULL,
  garment_id TEXT NOT NULL,
  field TEXT NOT NULL,
  value_json TEXT NOT NULL,
  source_kind TEXT NOT NULL,
  source_ref TEXT,
  observed_at TEXT NOT NULL,
  confidence REAL,
  scope TEXT,
  superseded_by TEXT,
  command_id TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (user_id, fact_id),
  FOREIGN KEY (user_id, garment_id) REFERENCES garments (user_id, garment_id)
);

-- Snapshot history of mutable rows (audit and compensating undo).
CREATE TABLE entity_history (
  user_id TEXT NOT NULL REFERENCES users(user_id),
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  snapshot_json TEXT NOT NULL,
  command_id TEXT,
  changed_at TEXT NOT NULL,
  PRIMARY KEY (user_id, entity_type, entity_id, version)
);

-- ---------------------------------------------------------------- stock lots and movements
CREATE TABLE stock_lots (
  user_id TEXT NOT NULL,
  lot_id TEXT NOT NULL,
  garment_id TEXT NOT NULL,
  clean_qty INTEGER NOT NULL DEFAULT 0 CHECK (clean_qty >= 0),
  worn_qty INTEGER NOT NULL DEFAULT 0 CHECK (worn_qty >= 0),
  hamper_qty INTEGER NOT NULL DEFAULT 0 CHECK (hamper_qty >= 0),
  laundry_qty INTEGER NOT NULL DEFAULT 0 CHECK (laundry_qty >= 0),
  storage_qty INTEGER NOT NULL DEFAULT 0 CHECK (storage_qty >= 0),
  away_qty INTEGER NOT NULL DEFAULT 0 CHECK (away_qty >= 0),
  retired_qty INTEGER NOT NULL DEFAULT 0 CHECK (retired_qty >= 0),
  -- per-bucket arrival instants of units (FIFO), materialized by the replay engine
  units_json TEXT NOT NULL DEFAULT '{}',
  replay_notes_json TEXT NOT NULL DEFAULT '[]',
  version INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id, lot_id),
  UNIQUE (user_id, garment_id, lot_id),
  FOREIGN KEY (user_id, garment_id) REFERENCES garments (user_id, garment_id)
);
CREATE INDEX lots_by_garment ON stock_lots (user_id, garment_id);

-- Journal of intended quantity changes. Balances are the event-ordered replay of the active rows.
CREATE TABLE stock_movements (
  user_id TEXT NOT NULL,
  movement_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  lot_id TEXT NOT NULL,
  garment_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('receive', 'wear', 'transfer', 'sweep', 'batch_collect', 'batch_return', 'reconcile_clean', 'reconcile_total', 'retire')),
  params_json TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  command_id TEXT,
  observation_id TEXT,
  batch_id TEXT,
  wear_key TEXT, -- garment_id|wearing_date for counted-wear consumption
  voided_at TEXT,
  voided_by_command TEXT,
  PRIMARY KEY (user_id, movement_id),
  FOREIGN KEY (user_id, lot_id) REFERENCES stock_lots (user_id, lot_id)
);
CREATE INDEX movements_by_lot ON stock_movements (user_id, lot_id, occurred_at, seq);
-- one active counted-wear consumption per garment and wearing date
CREATE UNIQUE INDEX movements_one_wear_per_day ON stock_movements (user_id, wear_key) WHERE kind = 'wear' AND voided_at IS NULL AND wear_key IS NOT NULL;

-- ---------------------------------------------------------------- restrictions and lifecycle
CREATE TABLE restrictions (
  user_id TEXT NOT NULL REFERENCES users(user_id),
  restriction_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  scope_json TEXT NOT NULL,
  reason TEXT NOT NULL,
  starts_at TEXT NOT NULL,
  expected_end TEXT, -- informational; never lifts the restriction
  required_evidence TEXT NOT NULL,
  rule_key TEXT, -- style rule that this restriction implements, if any
  lifted_at TEXT,
  lift_evidence TEXT,
  lifted_by_command TEXT,
  created_by_command TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (user_id, restriction_id)
);

CREATE TABLE lifecycle_projects (
  user_id TEXT NOT NULL REFERENCES users(user_id),
  project_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('tailoring', 'return', 'storage', 'sale', 'consignment', 'repair')),
  status TEXT NOT NULL,
  details_json TEXT NOT NULL DEFAULT '{}',
  expected_return TEXT,
  actual_return TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (user_id, project_id)
);

CREATE TABLE lifecycle_project_items (
  user_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  garment_id TEXT NOT NULL,
  quantity INTEGER NOT NULL DEFAULT 1 CHECK (quantity > 0),
  PRIMARY KEY (user_id, project_id, garment_id),
  FOREIGN KEY (user_id, project_id) REFERENCES lifecycle_projects (user_id, project_id),
  FOREIGN KEY (user_id, garment_id) REFERENCES garments (user_id, garment_id)
);

-- ---------------------------------------------------------------- orders, deadlines, feedback
CREATE TABLE orders (
  user_id TEXT NOT NULL REFERENCES users(user_id),
  order_id TEXT NOT NULL,
  merchant TEXT NOT NULL,
  merchant_order_number TEXT NOT NULL,
  ordered_at TEXT NOT NULL,
  currency TEXT NOT NULL,
  source_ref TEXT,
  status TEXT NOT NULL DEFAULT 'placed',
  created_at TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (user_id, order_id),
  UNIQUE (user_id, merchant, merchant_order_number)
);

CREATE TABLE order_lines (
  user_id TEXT NOT NULL,
  line_id TEXT NOT NULL,
  order_id TEXT NOT NULL,
  external_line_id TEXT NOT NULL,
  garment_id TEXT,
  description TEXT NOT NULL,
  spec_json TEXT NOT NULL DEFAULT '{}',
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  unit_price_minor INTEGER NOT NULL CHECK (unit_price_minor >= 0),
  currency TEXT NOT NULL,
  arrival_estimate TEXT, -- a predicted date is not a receipt
  arrived_qty INTEGER NOT NULL DEFAULT 0 CHECK (arrived_qty >= 0),
  refunded_minor INTEGER NOT NULL DEFAULT 0,
  remake_of_line_id TEXT,
  status TEXT NOT NULL DEFAULT 'ordered',
  version INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (user_id, line_id),
  UNIQUE (user_id, order_id, external_line_id),
  FOREIGN KEY (user_id, order_id) REFERENCES orders (user_id, order_id),
  FOREIGN KEY (user_id, garment_id) REFERENCES garments (user_id, garment_id)
);

CREATE TABLE return_deadlines (
  user_id TEXT NOT NULL,
  deadline_id TEXT NOT NULL,
  line_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('request', 'post', 'retailer_receipt')),
  deadline_at TEXT NOT NULL,
  timezone TEXT NOT NULL,
  terms_source TEXT NOT NULL, -- no invented deadlines: the source is mandatory
  checked_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  PRIMARY KEY (user_id, deadline_id),
  FOREIGN KEY (user_id, line_id) REFERENCES order_lines (user_id, line_id)
);

CREATE TABLE comfort_feedback (
  user_id TEXT NOT NULL REFERENCES users(user_id),
  feedback_id TEXT NOT NULL,
  garment_id TEXT,
  combination_ref TEXT,
  wearing_date TEXT,
  activity TEXT,
  layer TEXT,
  conditions_json TEXT NOT NULL DEFAULT '{}',
  text TEXT NOT NULL,
  scope TEXT NOT NULL DEFAULT 'observation',
  created_at TEXT NOT NULL,
  PRIMARY KEY (user_id, feedback_id),
  FOREIGN KEY (user_id, garment_id) REFERENCES garments (user_id, garment_id)
);

-- ---------------------------------------------------------------- wear observations and daily records
CREATE TABLE wear_observations (
  user_id TEXT NOT NULL REFERENCES users(user_id),
  observation_id TEXT NOT NULL,
  wearing_date TEXT NOT NULL,
  timezone TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  reported_at TEXT NOT NULL,
  source TEXT NOT NULL,
  source_ref TEXT,
  segment TEXT,
  option_id TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'superseded', 'retracted')),
  revision INTEGER NOT NULL DEFAULT 1,
  supersedes_observation_id TEXT,
  command_id TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (user_id, observation_id)
);
CREATE INDEX observations_by_date ON wear_observations (user_id, wearing_date);

CREATE TABLE observation_items (
  user_id TEXT NOT NULL,
  observation_id TEXT NOT NULL,
  garment_id TEXT NOT NULL,
  role TEXT,
  fresh_unit INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, observation_id, garment_id),
  FOREIGN KEY (user_id, observation_id) REFERENCES wear_observations (user_id, observation_id),
  FOREIGN KEY (user_id, garment_id) REFERENCES garments (user_id, garment_id)
);
CREATE INDEX observation_items_by_garment ON observation_items (user_id, garment_id);

-- The counted wear. One row per owner, garment and local wearing date.
CREATE TABLE daily_wears (
  user_id TEXT NOT NULL,
  garment_id TEXT NOT NULL,
  wearing_date TEXT NOT NULL,
  timezone TEXT NOT NULL,
  first_occurred_at TEXT NOT NULL,
  observation_count INTEGER NOT NULL,
  sources_json TEXT NOT NULL,
  segments_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'retracted')),
  revision INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id, garment_id, wearing_date),
  FOREIGN KEY (user_id, garment_id) REFERENCES garments (user_id, garment_id)
);
CREATE INDEX daily_wears_by_date ON daily_wears (user_id, wearing_date);

-- ---------------------------------------------------------------- laundry batches and estimates
CREATE TABLE laundry_batches (
  user_id TEXT NOT NULL REFERENCES users(user_id),
  batch_id TEXT NOT NULL,
  channel TEXT NOT NULL DEFAULT 'service' CHECK (channel = 'service'),
  status TEXT NOT NULL CHECK (status IN ('collected', 'partially_returned', 'returned', 'voided')),
  collected_at TEXT NOT NULL,
  returned_at TEXT,
  command_id TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (user_id, batch_id)
);

CREATE TABLE laundry_batch_items (
  user_id TEXT NOT NULL,
  batch_id TEXT NOT NULL,
  lot_id TEXT NOT NULL,
  garment_id TEXT NOT NULL,
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  returned_qty INTEGER NOT NULL DEFAULT 0 CHECK (returned_qty >= 0 AND returned_qty <= quantity),
  status TEXT NOT NULL DEFAULT 'away' CHECK (status IN ('away', 'returned', 'missing')),
  PRIMARY KEY (user_id, batch_id, lot_id),
  FOREIGN KEY (user_id, batch_id) REFERENCES laundry_batches (user_id, batch_id),
  FOREIGN KEY (user_id, lot_id) REFERENCES stock_lots (user_id, lot_id)
);

CREATE TABLE laundry_exceptions (
  user_id TEXT NOT NULL,
  exception_id TEXT NOT NULL,
  garment_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('still_away', 'missed_return', 'dirty', 'delay')),
  quantity INTEGER NOT NULL DEFAULT 1 CHECK (quantity > 0),
  batch_id TEXT,
  occurred_at TEXT NOT NULL,
  cleared_at TEXT,
  command_id TEXT,
  PRIMARY KEY (user_id, exception_id),
  FOREIGN KEY (user_id, garment_id) REFERENCES garments (user_id, garment_id)
);

-- Weekly cleanliness resets: applied once per owner, pool and cycle (estimate only, never a movement).
CREATE TABLE laundry_resets (
  user_id TEXT NOT NULL REFERENCES users(user_id),
  pool TEXT NOT NULL CHECK (pool IN ('service', 'hand_wash')),
  cycle_key TEXT NOT NULL,
  cutoff_at TEXT NOT NULL,
  effective_at TEXT NOT NULL,
  applied_at TEXT NOT NULL,
  routine_version INTEGER NOT NULL,
  PRIMARY KEY (user_id, pool, cycle_key)
);

-- ---------------------------------------------------------------- style documents and rules
CREATE TABLE style_documents (
  user_id TEXT NOT NULL REFERENCES users(user_id),
  document_id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version > 0),
  title TEXT NOT NULL,
  body TEXT NOT NULL, -- verbatim owner prose, never paraphrased
  content_sha256 TEXT NOT NULL,
  byte_length INTEGER NOT NULL,
  is_demo INTEGER NOT NULL DEFAULT 0,
  source TEXT NOT NULL, -- owner_supplied | owner_edit | import | synthetic_test
  authored_on TEXT,
  imported_at TEXT NOT NULL,
  created_by_command TEXT,
  is_current INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (user_id, document_id, version)
);
CREATE UNIQUE INDEX style_documents_one_current ON style_documents (user_id, document_id) WHERE is_current = 1;

CREATE TABLE style_rules (
  user_id TEXT NOT NULL REFERENCES users(user_id),
  rule_id TEXT NOT NULL,
  rule_key TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('hard_rule', 'standing_direction', 'temporary_brief')),
  strength TEXT NOT NULL CHECK (strength IN ('hard', 'soft')),
  category TEXT NOT NULL,
  statement TEXT NOT NULL,
  interpretation TEXT NOT NULL,
  machine_json TEXT NOT NULL DEFAULT '{}',
  exception_policy TEXT NOT NULL DEFAULT 'owner_scoped' CHECK (exception_policy IN ('none', 'owner_scoped', 'restriction_lift_only')),
  document_id TEXT,
  document_version INTEGER,
  passage_section TEXT,
  passage_quote TEXT,
  passage_status TEXT NOT NULL DEFAULT 'present' CHECK (passage_status IN ('present', 'missing', 'not_applicable')),
  overrides_rule_key TEXT,
  valid_from TEXT,
  valid_to TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'pending_activation', 'retired')),
  source TEXT NOT NULL,
  created_at TEXT NOT NULL,
  created_by_command TEXT,
  retired_at TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (user_id, rule_id)
);
CREATE UNIQUE INDEX style_rules_active_key ON style_rules (user_id, rule_key) WHERE status = 'active' AND kind <> 'temporary_brief';

CREATE TABLE profile_amendments (
  user_id TEXT NOT NULL REFERENCES users(user_id),
  amendment_id TEXT NOT NULL,
  document_id TEXT NOT NULL,
  text TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'incorporated', 'retired')),
  source TEXT NOT NULL,
  command_id TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (user_id, amendment_id)
);

-- ---------------------------------------------------------------- boards, options, selections
CREATE TABLE boards (
  user_id TEXT NOT NULL REFERENCES users(user_id),
  board_id TEXT NOT NULL,
  board_date TEXT NOT NULL,
  timezone TEXT NOT NULL,
  purpose TEXT NOT NULL DEFAULT 'day',
  current_revision INTEGER NOT NULL DEFAULT 0,
  brief_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'suppressed', 'archived')),
  published_at TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (user_id, board_id),
  UNIQUE (user_id, board_date, purpose)
);

CREATE TABLE board_revisions (
  user_id TEXT NOT NULL,
  board_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision > 0),
  published_at TEXT NOT NULL,
  context_json TEXT NOT NULL DEFAULT '{}',
  validation_json TEXT NOT NULL DEFAULT '{}',
  estimator_json TEXT NOT NULL DEFAULT '{}',
  PRIMARY KEY (user_id, board_id, revision),
  FOREIGN KEY (user_id, board_id) REFERENCES boards (user_id, board_id)
);

CREATE TABLE board_options (
  user_id TEXT NOT NULL,
  option_id TEXT NOT NULL,
  board_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  position INTEGER NOT NULL,
  explanation TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'offerable' CHECK (status IN ('offerable', 'reserve', 'withdrawn')),
  validation_json TEXT NOT NULL DEFAULT '{}',
  PRIMARY KEY (user_id, option_id),
  FOREIGN KEY (user_id, board_id, revision) REFERENCES board_revisions (user_id, board_id, revision)
);

CREATE TABLE option_garments (
  user_id TEXT NOT NULL,
  option_id TEXT NOT NULL,
  garment_id TEXT NOT NULL,
  role TEXT NOT NULL,
  alternative_group TEXT,
  PRIMARY KEY (user_id, option_id, garment_id),
  FOREIGN KEY (user_id, option_id) REFERENCES board_options (user_id, option_id),
  FOREIGN KEY (user_id, garment_id) REFERENCES garments (user_id, garment_id)
);

CREATE TABLE selections (
  user_id TEXT NOT NULL,
  selection_id TEXT NOT NULL,
  board_id TEXT NOT NULL,
  option_id TEXT NOT NULL,
  board_revision INTEGER NOT NULL,
  footwear_garment_id TEXT,
  selected_for_date TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'superseded', 'cleared')),
  command_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (user_id, selection_id),
  FOREIGN KEY (user_id, board_id) REFERENCES boards (user_id, board_id),
  FOREIGN KEY (user_id, option_id) REFERENCES board_options (user_id, option_id)
);
CREATE UNIQUE INDEX selections_one_active ON selections (user_id, board_id) WHERE status = 'active';

CREATE TABLE saved_combinations (
  user_id TEXT NOT NULL REFERENCES users(user_id),
  combination_id TEXT NOT NULL,
  name TEXT,
  slots_json TEXT NOT NULL,
  favorite INTEGER NOT NULL DEFAULT 0,
  planned_for_date TEXT,
  created_at TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (user_id, combination_id)
);

-- ---------------------------------------------------------------- measurements and fit
CREATE TABLE measurements (
  user_id TEXT NOT NULL REFERENCES users(user_id),
  measurement_id TEXT NOT NULL,
  subject TEXT NOT NULL CHECK (subject IN ('body', 'garment')),
  garment_id TEXT,
  name TEXT NOT NULL,
  value REAL NOT NULL,
  unit TEXT NOT NULL, -- units are explicit
  convention TEXT,
  measured_on TEXT NOT NULL,
  source TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (user_id, measurement_id),
  FOREIGN KEY (user_id, garment_id) REFERENCES garments (user_id, garment_id),
  CHECK (subject = 'body' OR garment_id IS NOT NULL)
);

CREATE TABLE fit_notes (
  user_id TEXT NOT NULL REFERENCES users(user_id),
  note_id TEXT NOT NULL,
  maker TEXT NOT NULL,
  model TEXT,
  size_label TEXT NOT NULL,
  size_system TEXT, -- maker-specific; never carried across makers
  experience TEXT NOT NULL,
  garment_id TEXT,
  source TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (user_id, note_id),
  FOREIGN KEY (user_id, garment_id) REFERENCES garments (user_id, garment_id)
);

-- ---------------------------------------------------------------- media references
CREATE TABLE media_assets (
  user_id TEXT NOT NULL REFERENCES users(user_id),
  asset_id TEXT NOT NULL,
  r2_key TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('source', 'cutout', 'catalogue', 'mask', 'thumbnail', 'composite')),
  source_asset_id TEXT,
  transformation_json TEXT NOT NULL DEFAULT '{}',
  content_type TEXT NOT NULL,
  width INTEGER,
  height INTEGER,
  sha256 TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'final', 'rejected')),
  created_at TEXT NOT NULL,
  PRIMARY KEY (user_id, asset_id),
  UNIQUE (user_id, r2_key)
);

CREATE TABLE garment_media (
  user_id TEXT NOT NULL,
  garment_id TEXT NOT NULL,
  asset_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('catalogue', 'supporting')),
  verified INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  PRIMARY KEY (user_id, garment_id, asset_id),
  FOREIGN KEY (user_id, garment_id) REFERENCES garments (user_id, garment_id),
  FOREIGN KEY (user_id, asset_id) REFERENCES media_assets (user_id, asset_id)
);

-- ---------------------------------------------------------------- commands, receipts, effects, runs
-- Precondition record: first statement of every command batch. A failed version or quantity
-- predicate raises a CHECK constraint error and rolls back the entire batch.
CREATE TABLE command_preconditions (
  check_id TEXT PRIMARY KEY,
  ok INTEGER NOT NULL CHECK (ok = 1)
);

CREATE TABLE command_receipts (
  user_id TEXT NOT NULL REFERENCES users(user_id),
  command_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  command_type TEXT NOT NULL,
  command_class TEXT NOT NULL,
  source TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('committed', 'merged')),
  receipt_json TEXT NOT NULL,
  undo_json TEXT, -- compensation plan; null when not reversible
  compensates_command_id TEXT,
  undone_by_command_id TEXT,
  occurred_at TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  PRIMARY KEY (user_id, command_id),
  UNIQUE (user_id, idempotency_key)
);
CREATE UNIQUE INDEX receipts_compensated_once ON command_receipts (user_id, compensates_command_id) WHERE compensates_command_id IS NOT NULL;

-- Receipts are never deleted.
CREATE TRIGGER command_receipts_no_delete BEFORE DELETE ON command_receipts
BEGIN
  SELECT RAISE(ABORT, 'command receipts are never deleted');
END;

CREATE TABLE command_receipt_entities (
  user_id TEXT NOT NULL,
  command_id TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  PRIMARY KEY (user_id, command_id, entity_type, entity_id),
  FOREIGN KEY (user_id, command_id) REFERENCES command_receipts (user_id, command_id)
);
CREATE INDEX receipt_entities_by_entity ON command_receipt_entities (user_id, entity_type, entity_id);

-- Transactional outbox of effects (board revalidation, Calendar projection, indexing, media).
CREATE TABLE command_effects (
  user_id TEXT NOT NULL,
  effect_id TEXT NOT NULL,
  command_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  external INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'dispatched', 'projected', 'failed', 'superseded')),
  operation_key TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}',
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id, effect_id),
  UNIQUE (user_id, operation_key),
  FOREIGN KEY (user_id, command_id) REFERENCES command_receipts (user_id, command_id)
);
CREATE INDEX effects_pending ON command_effects (status, kind);

-- Durable action intents registered by the assistant before dispatching an effect (section 8).
CREATE TABLE action_intents (
  user_id TEXT NOT NULL REFERENCES users(user_id),
  action_id TEXT NOT NULL,
  parent_ref TEXT NOT NULL,
  operation TEXT NOT NULL,
  target_ids_json TEXT NOT NULL,
  effect_hash TEXT NOT NULL,
  expected_versions_json TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'committed', 'failed', 'cancelled')),
  command_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id, action_id),
  UNIQUE (user_id, parent_ref, effect_hash)
);

CREATE TABLE runs (
  user_id TEXT NOT NULL REFERENCES users(user_id),
  run_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  parent_ref TEXT,
  input_json TEXT NOT NULL DEFAULT '{}',
  result_json TEXT,
  deadline_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (user_id, run_id)
);

-- ---------------------------------------------------------------- trips and packing
CREATE TABLE trips (
  user_id TEXT NOT NULL REFERENCES users(user_id),
  trip_id TEXT NOT NULL,
  name TEXT NOT NULL,
  departs_on TEXT NOT NULL,
  returns_on TEXT NOT NULL,
  destinations_json TEXT NOT NULL DEFAULT '[]',
  timezone TEXT NOT NULL,
  luggage TEXT,
  laundry_opportunities_json TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'planned',
  version INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (user_id, trip_id),
  CHECK (returns_on >= departs_on)
);

CREATE TABLE trip_items (
  user_id TEXT NOT NULL,
  trip_id TEXT NOT NULL,
  garment_id TEXT NOT NULL,
  proposed_qty INTEGER NOT NULL DEFAULT 0 CHECK (proposed_qty >= 0),
  packed_qty INTEGER NOT NULL DEFAULT 0 CHECK (packed_qty >= 0),
  PRIMARY KEY (user_id, trip_id, garment_id),
  FOREIGN KEY (user_id, trip_id) REFERENCES trips (user_id, trip_id),
  FOREIGN KEY (user_id, garment_id) REFERENCES garments (user_id, garment_id)
);

-- ---------------------------------------------------------------- pause, recovery, export, import
CREATE TABLE service_pauses (
  user_id TEXT NOT NULL REFERENCES users(user_id),
  pause_id TEXT NOT NULL,
  scopes_json TEXT NOT NULL,
  starts_on TEXT NOT NULL,
  resume_on TEXT, -- null = indefinite
  ended_at TEXT,
  command_id TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (user_id, pause_id)
);

CREATE TABLE recovery_credentials (
  user_id TEXT NOT NULL REFERENCES users(user_id),
  credential_id TEXT NOT NULL,
  verifier_hash TEXT NOT NULL, -- only the verifier is stored
  created_at TEXT NOT NULL,
  used_at TEXT,
  revoked_at TEXT,
  PRIMARY KEY (user_id, credential_id)
);

CREATE TABLE export_manifests (
  user_id TEXT NOT NULL REFERENCES users(user_id),
  export_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'complete', 'incomplete', 'failed')),
  manifest_json TEXT NOT NULL DEFAULT '{}',
  watermark TEXT,
  r2_key TEXT,
  created_at TEXT NOT NULL,
  completed_at TEXT,
  PRIMARY KEY (user_id, export_id)
);

CREATE TABLE import_runs (
  user_id TEXT NOT NULL REFERENCES users(user_id),
  import_id TEXT NOT NULL,
  source_system TEXT NOT NULL,
  source_label TEXT,
  source_sha256 TEXT,
  row_count INTEGER NOT NULL DEFAULT 0,
  report_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  PRIMARY KEY (user_id, import_id)
);

-- Every source row is accounted for: imported, merged (with an explicit mapping) or held for resolution.
CREATE TABLE import_references (
  user_id TEXT NOT NULL REFERENCES users(user_id),
  source_system TEXT NOT NULL,
  source_id TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT, -- null while held
  disposition TEXT NOT NULL DEFAULT 'imported' CHECK (disposition IN ('imported', 'merged', 'held')),
  source_row INTEGER,
  source_row_sha256 TEXT,
  note TEXT,
  import_id TEXT,
  imported_at TEXT NOT NULL,
  PRIMARY KEY (user_id, source_system, entity_type, source_id),
  CHECK (disposition = 'held' OR entity_id IS NOT NULL)
);

CREATE TABLE migration_issues (
  user_id TEXT NOT NULL REFERENCES users(user_id),
  issue_id TEXT NOT NULL,
  source_system TEXT NOT NULL,
  source_id TEXT,
  issue_key TEXT NOT NULL, -- stable key, deduplicates repeated imports
  kind TEXT NOT NULL,
  severity TEXT NOT NULL DEFAULT 'review' CHECK (severity IN ('info', 'review', 'conflict')),
  entity_id TEXT,
  detail TEXT NOT NULL,
  evidence_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'open',
  created_at TEXT NOT NULL,
  PRIMARY KEY (user_id, issue_id),
  UNIQUE (user_id, issue_key)
);
