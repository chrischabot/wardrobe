-- Foundation migration 0002: conflicts between a saved profile text and the structured facts that quote it
-- (specification section 6, "Save in My style"), and retirement of size experiences.
--
-- A structured fact (machine rule, dated measurement, size experience) quotes a passage of the profile.
-- When a save removes or rewords that passage and the owner gave no decision, the fact stays in force and
-- one row here keeps the disagreement visible until the owner resolves it. Nothing in this table is a
-- resolution the application invented.

CREATE TABLE style_fact_conflicts (
  user_id                TEXT NOT NULL REFERENCES users(user_id),
  conflict_id            TEXT NOT NULL,
  document_id            TEXT NOT NULL,
  from_version           INTEGER NOT NULL,
  to_version             INTEGER NOT NULL,
  fact_kind              TEXT NOT NULL CHECK (fact_kind IN ('rule', 'measurement', 'size_experience')),
  fact_id                TEXT NOT NULL,
  fact_label             TEXT NOT NULL,
  reason                 TEXT NOT NULL CHECK (reason IN ('passage_removed', 'passage_changed')),
  previous_passages_json TEXT NOT NULL,
  missing_quotes_json    TEXT NOT NULL,
  candidate_text         TEXT,
  status                 TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved', 'withdrawn')),
  resolution_json        TEXT,
  command_id             TEXT NOT NULL,
  resolved_command_id    TEXT,
  created_at             TEXT NOT NULL,
  resolved_at            TEXT,
  PRIMARY KEY (user_id, conflict_id),
  FOREIGN KEY (user_id, document_id, to_version) REFERENCES style_documents(user_id, document_id, version)
);
-- A fact has at most one undecided conflict at a time.
CREATE UNIQUE INDEX style_fact_conflicts_open ON style_fact_conflicts(user_id, fact_kind, fact_id) WHERE status = 'open';
CREATE INDEX style_fact_conflicts_document ON style_fact_conflicts(user_id, document_id, status);

-- A size experience the owner says no longer applies is retired, never deleted.
ALTER TABLE size_experiences ADD COLUMN retired_at TEXT;
ALTER TABLE size_experiences ADD COLUMN retired_by_command_id TEXT;
