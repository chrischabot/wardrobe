-- Visual wardrobe, media pipeline and Studio (spec sections 3 "Studio" and 11).
-- Additive only: 0001 stays frozen. D1 holds identities and metadata; image bytes live in private R2.

-- ---------------------------------------------------------------- media asset provenance
-- What an image is evidence of, where it came from, and whether an edit kept the garment's identity.
ALTER TABLE media_assets ADD COLUMN asset_class TEXT NOT NULL DEFAULT 'owner_photo'
  CHECK (asset_class IN ('exact_product_photo', 'owner_photo', 'edited_rendition', 'illustration', 'demo_placeholder', 'imagined_rendering', 'composite'));
ALTER TABLE media_assets ADD COLUMN byte_length INTEGER;
ALTER TABLE media_assets ADD COLUMN source_url TEXT;
ALTER TABLE media_assets ADD COLUMN source_page_url TEXT;
ALTER TABLE media_assets ADD COLUMN retrieved_at TEXT;
ALTER TABLE media_assets ADD COLUMN permitted_use TEXT;
ALTER TABLE media_assets ADD COLUMN evidence_json TEXT NOT NULL DEFAULT '{}';
ALTER TABLE media_assets ADD COLUMN fidelity_json TEXT;
ALTER TABLE media_assets ADD COLUMN label TEXT;
ALTER TABLE media_assets ADD COLUMN rejection_reason TEXT;
ALTER TABLE media_assets ADD COLUMN deleted_at TEXT;
CREATE INDEX media_assets_by_source ON media_assets (user_id, source_asset_id);

-- An imagined rendering can never be linked to a garment as its catalogue image.
CREATE TRIGGER garment_media_no_imagined_catalogue
BEFORE INSERT ON garment_media
WHEN NEW.role = 'catalogue' AND (SELECT asset_class FROM media_assets WHERE user_id = NEW.user_id AND asset_id = NEW.asset_id) IN ('imagined_rendering', 'composite')
BEGIN
  SELECT RAISE(ABORT, 'imagined renderings and composites cannot be catalogue images');
END;

-- A catalogue link needs a final (validated) asset: uploads become evidence only after finalization.
CREATE TRIGGER garment_media_final_only
BEFORE INSERT ON garment_media
WHEN (SELECT status FROM media_assets WHERE user_id = NEW.user_id AND asset_id = NEW.asset_id) <> 'final'
BEGIN
  SELECT RAISE(ABORT, 'only finalized assets can be linked to a garment');
END;

CREATE UNIQUE INDEX garment_media_one_catalogue ON garment_media (user_id, garment_id) WHERE role = 'catalogue';

-- ---------------------------------------------------------------- uploads
-- Short-lived authorization, size limit and explicit finalization before an image enters a task.
CREATE TABLE media_uploads (
  user_id TEXT NOT NULL REFERENCES users(user_id),
  upload_id TEXT NOT NULL,
  purpose TEXT NOT NULL CHECK (purpose IN ('garment_photo', 'identify', 'what_i_wore', 'product', 'receipt')),
  content_type TEXT NOT NULL CHECK (content_type IN ('image/jpeg', 'image/heic', 'image/png')),
  declared_bytes INTEGER NOT NULL CHECK (declared_bytes > 0 AND declared_bytes <= 25000000),
  received_bytes INTEGER,
  garment_id TEXT,
  r2_key TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'authorized' CHECK (status IN ('authorized', 'uploaded', 'finalized', 'rejected', 'expired')),
  rejection_reason TEXT,
  asset_id TEXT,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id, upload_id),
  UNIQUE (user_id, r2_key),
  FOREIGN KEY (user_id, garment_id) REFERENCES garments (user_id, garment_id)
);

-- ---------------------------------------------------------------- discovery and normalization jobs
-- Durable job ledger fed through MEDIA_QUEUE. A queue message carries only (userId, jobId).
CREATE TABLE media_jobs (
  user_id TEXT NOT NULL REFERENCES users(user_id),
  job_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('discover', 'normalize', 'composite')),
  garment_id TEXT,
  operation_key TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'succeeded', 'unresolved', 'waiting_provider', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  input_json TEXT NOT NULL DEFAULT '{}',
  result_json TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id, job_id),
  UNIQUE (user_id, operation_key),
  FOREIGN KEY (user_id, garment_id) REFERENCES garments (user_id, garment_id)
);
CREATE INDEX media_jobs_by_garment ON media_jobs (user_id, garment_id, created_at);

-- Per-garment image search state: the bounded "try hard" allowance and the Photos needed collection.
CREATE TABLE garment_photo_status (
  user_id TEXT NOT NULL,
  garment_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('searching', 'resolved', 'needs_review', 'photos_needed')),
  strategies_used INTEGER NOT NULL DEFAULT 0,
  candidate_pages INTEGER NOT NULL DEFAULT 0,
  browser_sessions INTEGER NOT NULL DEFAULT 0,
  tried_json TEXT NOT NULL DEFAULT '[]',
  review_json TEXT NOT NULL DEFAULT '[]',
  request_text TEXT,
  last_searched_at TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id, garment_id),
  FOREIGN KEY (user_id, garment_id) REFERENCES garments (user_id, garment_id)
);

-- ---------------------------------------------------------------- outfit composites
-- Manifest hash identifies the cached output; a swap changes one reference and so one hash.
CREATE TABLE outfit_composites (
  user_id TEXT NOT NULL REFERENCES users(user_id),
  manifest_hash TEXT NOT NULL,
  layout_version TEXT NOT NULL,
  manifest_json TEXT NOT NULL,
  garment_ids_json TEXT NOT NULL,
  asset_id TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (user_id, manifest_hash),
  FOREIGN KEY (user_id, asset_id) REFERENCES media_assets (user_id, asset_id)
);

-- ---------------------------------------------------------------- Studio: saved combinations and plans
ALTER TABLE saved_combinations ADD COLUMN kind TEXT NOT NULL DEFAULT 'saved' CHECK (kind IN ('saved', 'plan'));
ALTER TABLE saved_combinations ADD COLUMN mode TEXT NOT NULL DEFAULT 'today' CHECK (mode IN ('today', 'explore'));
ALTER TABLE saved_combinations ADD COLUMN status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'removed', 'superseded'));
ALTER TABLE saved_combinations ADD COLUMN command_id TEXT;
ALTER TABLE saved_combinations ADD COLUMN updated_at TEXT;
CREATE UNIQUE INDEX saved_combinations_one_plan_per_day ON saved_combinations (user_id, planned_for_date) WHERE kind = 'plan' AND status = 'active';
CREATE INDEX saved_combinations_by_status ON saved_combinations (user_id, status, kind);
