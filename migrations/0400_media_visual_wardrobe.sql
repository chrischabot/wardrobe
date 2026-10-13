-- Visual wardrobe (specification section 11): private media metadata, renditions, fidelity checks,
-- image discovery, the media job ledger, outfit composites and the Studio.
--
-- D1 holds identities and metadata only; image bytes live in the private R2 bucket under
-- `u/<user_id>/...`. Every table is owner-qualified with compound foreign keys, so a row can never
-- reference another owner's garment, asset or combination.

-- ---------------------------------------------------------------------------------------------
-- Uploads: short-lived authorization, then an explicit finalization step
-- ---------------------------------------------------------------------------------------------
CREATE TABLE media_uploads (
  user_id          TEXT NOT NULL REFERENCES users(user_id),
  upload_id        TEXT NOT NULL,
  intent           TEXT NOT NULL CHECK (intent IN ('garment_photo', 'selfie', 'attachment')),
  garment_id       TEXT,
  content_type     TEXT NOT NULL,
  declared_bytes   INTEGER NOT NULL CHECK (declared_bytes > 0),
  max_bytes        INTEGER NOT NULL CHECK (max_bytes > 0),
  wearing_date     TEXT,
  is_demo          INTEGER NOT NULL DEFAULT 0 CHECK (is_demo IN (0, 1)),
  origin           TEXT NOT NULL DEFAULT 'owner_upload' CHECK (origin IN ('owner_upload', 'drive_import', 'image_model')),
  origin_ref       TEXT,
  state            TEXT NOT NULL DEFAULT 'authorized' CHECK (state IN ('authorized', 'finalized', 'rejected')),
  rejection_reason TEXT,
  asset_id         TEXT,
  expires_at       TEXT NOT NULL,
  command_id       TEXT NOT NULL,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  PRIMARY KEY (user_id, upload_id),
  FOREIGN KEY (user_id, garment_id) REFERENCES garments(user_id, garment_id)
);

-- ---------------------------------------------------------------------------------------------
-- Assets and renditions
-- ---------------------------------------------------------------------------------------------
CREATE TABLE media_assets (
  user_id               TEXT NOT NULL REFERENCES users(user_id),
  asset_id              TEXT NOT NULL,
  garment_id            TEXT,
  kind                  TEXT NOT NULL CHECK (kind IN ('exact_product_photo', 'owner_photo', 'edited_rendition', 'generic_illustration', 'selfie', 'attachment')),
  is_demo               INTEGER NOT NULL DEFAULT 0 CHECK (is_demo IN (0, 1)),
  status                TEXT NOT NULL CHECK (status IN ('processing', 'active', 'needs_review', 'rejected', 'deleted')),
  status_reason         TEXT,
  source_json           TEXT NOT NULL,
  match_evidence_json   TEXT NOT NULL DEFAULT '{}',
  derived_from_asset_id TEXT,
  had_location_metadata INTEGER NOT NULL DEFAULT 0 CHECK (had_location_metadata IN (0, 1)),
  wearing_date          TEXT,
  retain_original_until TEXT,
  original_purged_at    TEXT,
  upload_id             TEXT,
  version               INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  command_id            TEXT NOT NULL,
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL,
  deleted_at            TEXT,
  PRIMARY KEY (user_id, asset_id),
  FOREIGN KEY (user_id, garment_id) REFERENCES garments(user_id, garment_id),
  FOREIGN KEY (user_id, derived_from_asset_id) REFERENCES media_assets(user_id, asset_id),
  -- An edit, an illustration or a demo placeholder can never be recorded as an exact product photograph.
  CHECK (NOT (is_demo = 1 AND kind = 'exact_product_photo'))
);
CREATE INDEX media_assets_garment ON media_assets(user_id, garment_id, status);
CREATE INDEX media_assets_retention ON media_assets(retain_original_until) WHERE retain_original_until IS NOT NULL AND original_purged_at IS NULL;

CREATE TABLE media_renditions (
  user_id             TEXT NOT NULL REFERENCES users(user_id),
  rendition_id        TEXT NOT NULL,
  asset_id            TEXT NOT NULL,
  kind                TEXT NOT NULL CHECK (kind IN ('original', 'display', 'cutout', 'mask', 'catalogue', 'edited')),
  version             INTEGER NOT NULL CHECK (version >= 1),
  object_key          TEXT NOT NULL,
  content_type        TEXT NOT NULL,
  width               INTEGER,
  height              INTEGER,
  byte_length         INTEGER NOT NULL CHECK (byte_length >= 0),
  sha256              TEXT NOT NULL,
  source_rendition_id TEXT,
  transformations_json TEXT NOT NULL DEFAULT '[]',
  edited              INTEGER NOT NULL DEFAULT 0 CHECK (edited IN (0, 1)),
  status              TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'superseded', 'rejected', 'deleted')),
  command_id          TEXT NOT NULL,
  created_at          TEXT NOT NULL,
  PRIMARY KEY (user_id, rendition_id),
  FOREIGN KEY (user_id, asset_id) REFERENCES media_assets(user_id, asset_id),
  FOREIGN KEY (user_id, source_rendition_id) REFERENCES media_renditions(user_id, rendition_id),
  UNIQUE (user_id, asset_id, kind, version),
  -- The immutable original has no source; every derivative names the rendition it came from.
  CHECK ((kind = 'original' AND source_rendition_id IS NULL) OR (kind != 'original' AND source_rendition_id IS NOT NULL)),
  -- Object keys are always inside the owner's prefix.
  CHECK (substr(object_key, 1, length(user_id) + 3) = 'u/' || user_id || '/')
);
CREATE INDEX media_renditions_asset ON media_renditions(user_id, asset_id, kind, status);

CREATE TABLE media_fidelity_checks (
  user_id           TEXT NOT NULL REFERENCES users(user_id),
  check_id          TEXT NOT NULL,
  asset_id          TEXT NOT NULL,
  subject           TEXT NOT NULL CHECK (subject IN ('cutout', 'edit')),
  rendition_id      TEXT,
  verdict           TEXT NOT NULL CHECK (verdict IN ('passed', 'failed')),
  failed_json       TEXT NOT NULL DEFAULT '[]',
  checks_json       TEXT NOT NULL,
  algorithm_version TEXT NOT NULL,
  command_id        TEXT NOT NULL,
  created_at        TEXT NOT NULL,
  PRIMARY KEY (user_id, check_id),
  FOREIGN KEY (user_id, asset_id) REFERENCES media_assets(user_id, asset_id)
);
CREATE INDEX media_fidelity_asset ON media_fidelity_checks(user_id, asset_id, created_at);

-- Per-garment image state: the approved asset, or the honest reason there is none.
CREATE TABLE garment_media (
  user_id          TEXT NOT NULL REFERENCES users(user_id),
  garment_id       TEXT NOT NULL,
  image_state      TEXT NOT NULL DEFAULT 'not_started' CHECK (image_state IN ('not_started', 'searching', 'resolved', 'needs_review', 'photos_needed')),
  primary_asset_id TEXT,
  photo_request    TEXT,
  photos_needed_at TEXT,
  last_failure     TEXT,
  discovery_json   TEXT NOT NULL DEFAULT '{}',
  version          INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  updated_at       TEXT NOT NULL,
  PRIMARY KEY (user_id, garment_id),
  FOREIGN KEY (user_id, garment_id) REFERENCES garments(user_id, garment_id),
  FOREIGN KEY (user_id, primary_asset_id) REFERENCES media_assets(user_id, asset_id),
  CHECK (image_state != 'resolved' OR primary_asset_id IS NOT NULL),
  CHECK (image_state != 'photos_needed' OR photo_request IS NOT NULL)
);
CREATE INDEX garment_media_state ON garment_media(user_id, image_state);

-- ---------------------------------------------------------------------------------------------
-- Image discovery: bounded attempts and their candidates
-- ---------------------------------------------------------------------------------------------
CREATE TABLE media_discovery_attempts (
  user_id          TEXT NOT NULL REFERENCES users(user_id),
  attempt_id       TEXT NOT NULL,
  garment_id       TEXT NOT NULL,
  strategy         TEXT NOT NULL CHECK (strategy IN ('purchase_source', 'maker_catalogue', 'identifier_search')),
  query_hash       TEXT NOT NULL,
  query_json       TEXT NOT NULL,
  provider         TEXT NOT NULL,
  pages_examined   INTEGER NOT NULL DEFAULT 0 CHECK (pages_examined >= 0),
  browser_sessions INTEGER NOT NULL DEFAULT 0 CHECK (browser_sessions >= 0),
  browser_seconds  INTEGER NOT NULL DEFAULT 0 CHECK (browser_seconds >= 0),
  outcome          TEXT NOT NULL CHECK (outcome IN ('adopted', 'needs_review', 'no_match', 'provider_unavailable', 'provider_error', 'budget_exhausted')),
  detail           TEXT,
  command_id       TEXT NOT NULL,
  created_at       TEXT NOT NULL,
  PRIMARY KEY (user_id, attempt_id),
  FOREIGN KEY (user_id, garment_id) REFERENCES garments(user_id, garment_id),
  -- The same search is never repeated for a garment: a retry must use a new source or query.
  UNIQUE (user_id, garment_id, strategy, query_hash)
);
CREATE INDEX media_discovery_day ON media_discovery_attempts(user_id, created_at);

CREATE TABLE media_candidates (
  user_id         TEXT NOT NULL REFERENCES users(user_id),
  candidate_id    TEXT NOT NULL,
  garment_id      TEXT NOT NULL,
  attempt_id      TEXT NOT NULL,
  page_url        TEXT,
  image_url       TEXT,
  identifiers_json TEXT NOT NULL DEFAULT '{}',
  evidence_json   TEXT NOT NULL DEFAULT '{}',
  decision        TEXT NOT NULL CHECK (decision IN ('adopted', 'needs_review', 'rejected')),
  rejection_reasons_json TEXT NOT NULL DEFAULT '[]',
  review_question TEXT,
  asset_id        TEXT,
  image_sha256    TEXT,
  retrieved_at    TEXT,
  decided_by      TEXT NOT NULL DEFAULT 'pipeline' CHECK (decided_by IN ('pipeline', 'owner')),
  command_id      TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  PRIMARY KEY (user_id, candidate_id),
  FOREIGN KEY (user_id, garment_id) REFERENCES garments(user_id, garment_id),
  FOREIGN KEY (user_id, attempt_id) REFERENCES media_discovery_attempts(user_id, attempt_id),
  FOREIGN KEY (user_id, asset_id) REFERENCES media_assets(user_id, asset_id)
);
CREATE INDEX media_candidates_review ON media_candidates(user_id, decision, created_at);
CREATE INDEX media_candidates_garment ON media_candidates(user_id, garment_id);

-- ---------------------------------------------------------------------------------------------
-- Durable job ledger. Queue messages carry only (user_id, job_id); this table is the truth.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE media_jobs (
  user_id      TEXT NOT NULL REFERENCES users(user_id),
  job_id       TEXT NOT NULL,
  kind         TEXT NOT NULL CHECK (kind IN ('normalize', 'discover', 'render_composite', 'purge_objects')),
  subject_id   TEXT NOT NULL,
  dedupe_key   TEXT NOT NULL,
  state        TEXT NOT NULL DEFAULT 'queued' CHECK (state IN ('queued', 'running', 'succeeded', 'failed', 'dead')),
  attempts     INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  max_attempts INTEGER NOT NULL DEFAULT 3 CHECK (max_attempts >= 1),
  payload_json TEXT NOT NULL DEFAULT '{}',
  result_json  TEXT,
  last_error   TEXT,
  lease_until  TEXT,
  command_id   TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  PRIMARY KEY (user_id, job_id),
  UNIQUE (user_id, dedupe_key)
);
CREATE INDEX media_jobs_state ON media_jobs(state, updated_at);

-- ---------------------------------------------------------------------------------------------
-- Outfit composites, keyed by the content hash of their manifest
-- ---------------------------------------------------------------------------------------------
CREATE TABLE outfit_composites (
  user_id          TEXT NOT NULL REFERENCES users(user_id),
  manifest_hash    TEXT NOT NULL,
  manifest_json    TEXT NOT NULL,
  template_version TEXT NOT NULL,
  preview_state    TEXT NOT NULL DEFAULT 'none' CHECK (preview_state IN ('none', 'queued', 'rendered', 'failed')),
  preview_key      TEXT,
  preview_sha256   TEXT,
  preview_bytes    INTEGER,
  svg_key          TEXT,
  failure          TEXT,
  rendered_at      TEXT,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  PRIMARY KEY (user_id, manifest_hash),
  CHECK (preview_key IS NULL OR substr(preview_key, 1, length(user_id) + 3) = 'u/' || user_id || '/')
);

-- Which garments a composite shows, so deleting or re-rendering one asset touches only the affected composites.
CREATE TABLE outfit_composite_items (
  user_id       TEXT NOT NULL,
  manifest_hash TEXT NOT NULL,
  garment_id    TEXT NOT NULL,
  rendition_id  TEXT,
  PRIMARY KEY (user_id, manifest_hash, garment_id),
  FOREIGN KEY (user_id, manifest_hash) REFERENCES outfit_composites(user_id, manifest_hash),
  FOREIGN KEY (user_id, garment_id) REFERENCES garments(user_id, garment_id)
);
CREATE INDEX outfit_composite_items_rendition ON outfit_composite_items(user_id, rendition_id);

-- ---------------------------------------------------------------------------------------------
-- Studio: saved combinations and day plans (intentions, never wears)
-- ---------------------------------------------------------------------------------------------
CREATE TABLE studio_combinations (
  user_id         TEXT NOT NULL REFERENCES users(user_id),
  combination_id  TEXT NOT NULL,
  name            TEXT,
  favourite       INTEGER NOT NULL DEFAULT 0 CHECK (favourite IN (0, 1)),
  slots_json      TEXT NOT NULL,
  signature       TEXT NOT NULL,
  has_candidate   INTEGER NOT NULL DEFAULT 0 CHECK (has_candidate IN (0, 1)),
  status          TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'removed')),
  validation_json TEXT NOT NULL,
  manifest_hash   TEXT,
  version         INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  command_id      TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  removed_at      TEXT,
  PRIMARY KEY (user_id, combination_id)
);
CREATE INDEX studio_combinations_status ON studio_combinations(user_id, status, updated_at);

CREATE TABLE studio_combination_items (
  user_id        TEXT NOT NULL,
  combination_id TEXT NOT NULL,
  role           TEXT NOT NULL,
  garment_id     TEXT NOT NULL,
  PRIMARY KEY (user_id, combination_id, role, garment_id),
  FOREIGN KEY (user_id, combination_id) REFERENCES studio_combinations(user_id, combination_id),
  FOREIGN KEY (user_id, garment_id) REFERENCES garments(user_id, garment_id)
);
CREATE INDEX studio_combination_items_garment ON studio_combination_items(user_id, garment_id);

CREATE TABLE studio_day_plans (
  user_id              TEXT NOT NULL REFERENCES users(user_id),
  plan_id              TEXT NOT NULL,
  local_date           TEXT NOT NULL,
  combination_id       TEXT,
  slots_json           TEXT NOT NULL,
  status               TEXT NOT NULL DEFAULT 'planned' CHECK (status IN ('planned', 'removed')),
  needs_revalidation   INTEGER NOT NULL DEFAULT 0 CHECK (needs_revalidation IN (0, 1)),
  revalidation_reason  TEXT,
  validation_json      TEXT NOT NULL,
  exposure_id          TEXT,
  version              INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  command_id           TEXT NOT NULL,
  created_at           TEXT NOT NULL,
  updated_at           TEXT NOT NULL,
  removed_at           TEXT,
  PRIMARY KEY (user_id, plan_id),
  FOREIGN KEY (user_id, combination_id) REFERENCES studio_combinations(user_id, combination_id)
);
-- At most one active Studio plan per owner and date.
CREATE UNIQUE INDEX studio_day_plans_active_date ON studio_day_plans(user_id, local_date) WHERE status = 'planned';

CREATE TABLE studio_day_plan_items (
  user_id    TEXT NOT NULL,
  plan_id    TEXT NOT NULL,
  role       TEXT NOT NULL,
  garment_id TEXT NOT NULL,
  PRIMARY KEY (user_id, plan_id, role, garment_id),
  FOREIGN KEY (user_id, plan_id) REFERENCES studio_day_plans(user_id, plan_id),
  FOREIGN KEY (user_id, garment_id) REFERENCES garments(user_id, garment_id)
);
CREATE INDEX studio_day_plan_items_garment ON studio_day_plan_items(user_id, garment_id);
