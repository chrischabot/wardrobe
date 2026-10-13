-- Owner task routing for inference (which verified model profile serves which task).
CREATE TABLE inference_routing (
  user_id        TEXT NOT NULL REFERENCES users(user_id),
  task           TEXT NOT NULL,
  version        INTEGER NOT NULL DEFAULT 1,
  profile_id     TEXT NOT NULL,
  fallbacks_json TEXT NOT NULL DEFAULT '[]',
  evaluation_ref TEXT,
  command_id     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  PRIMARY KEY (user_id, task)
);
