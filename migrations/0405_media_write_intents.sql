-- Visual wardrobe: durable record of every file a background job writes, so a write that lands late is removed.
--
-- A job run writes its files through a gate that admits a write only while the run holds its lease. A write
-- already under way when the run is stopped can still land afterwards: the runner waits for it for at most one
-- lease, then lets the lease lapse. By then a newer attempt may have finished, or the image may have been deleted
-- and its files purged, so a file landing late could bring back an invalidated or deleted image.
--
-- Before each write starts, the run records its intent here; when the write has finished (stored or failed) the
-- intent is marked settled. The maintenance sweep (packages/media/src/write-intents.ts) looks at a key once every
-- intent on it is past its own settle_after (fixed when the intent was written, from the bounds of the run that
-- wrote it) and no writer of it holds a live lease:
--   * a file a live record names is kept; its settled intents are dropped, unsettled ones stay watched;
--   * any other file is removed under a cleanup claim (media_write_cleanups). While the claim stands no job may
--     start a write to that key (the intent insert is refused), so a newer run cannot publish the key while its
--     removal is under way. The claim is released when the removal has completed; a claim whose sweep stopped
--     lapses only after a day, longer than any Worker invocation (and so any removal it started) can run.
--     Settled intents are then dropped; an unsettled one stays watched, so a write that
--     lands later still is removed by a later sweep, until one day after it began (longer than any Worker
--     invocation can run, after which the write can no longer land).

CREATE TABLE media_write_intents (
  user_id TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  object_key TEXT NOT NULL,
  job_id TEXT NOT NULL,
  job_attempt INTEGER NOT NULL,
  write_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  settle_after TEXT NOT NULL,
  settled_at TEXT,
  checked_at TEXT,
  PRIMARY KEY (user_id, object_key, write_id),
  CHECK (substr(object_key, 1, length(user_id) + 3) = 'u/' || user_id || '/')
);

CREATE INDEX media_write_intents_settle ON media_write_intents (settle_after);

CREATE TABLE media_write_cleanups (
  user_id TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  object_key TEXT NOT NULL,
  claimed_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  PRIMARY KEY (user_id, object_key),
  CHECK (substr(object_key, 1, length(user_id) + 3) = 'u/' || user_id || '/')
);

-- Job attempts whose files the sweep removed. Recorded under the cleanup claim before the removal; every job result
-- is refused in its commit while its attempt is listed here, so a result that arrives late (even after the claim
-- is released) can never publish a removed file. An attempt never becomes current again once superseded, so rows
-- are pruned once their attempt is no longer the job's running one.
CREATE TABLE media_swept_attempts (
  user_id TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  job_id TEXT NOT NULL,
  job_attempt INTEGER NOT NULL,
  swept_at TEXT NOT NULL,
  PRIMARY KEY (user_id, job_id, job_attempt)
);
