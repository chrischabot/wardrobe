-- Visual wardrobe: durable search claims and browser-time reservations for image discovery.
--
-- Before any discovery search is dispatched, the job writes a claim for it (owner, garment, query and retry
-- number). A browser-using search also reserves the seconds it may spend: the claim is inserted only while
-- every open claim's seconds plus the browser time recorded since the allowance was read plus the new
-- reservation fit in what remains of the owner's allowance, all checked in the insert itself.
--
-- As soon as the search returns, its claim is settled with what it actually used (pages, sessions, seconds)
-- and kept until the job's attempts are recorded, so a job that stops between the search and the record
-- neither loses the spent browser time nor repeats the search: the next run finds the settled claim and
-- records it instead, with the pages it returned (their candidates are evaluated then, not searched for again),
-- the pages it examined and whether its failure (if any) may be retried. A claim left unsettled (the run stopped during the search) is recorded as interrupted
-- with its reserved seconds counted as spent. A claim belongs to one job attempt: claims are written and taken
-- over only by a job's current running attempt, atomically and only from an attempt that is no longer running
-- under a live lease, and only its owner settles or releases it.
-- Claims are removed once their attempt is recorded; an unsettled one lapses at expires_at, which covers its
-- whole bounded search (its time allowance plus a lease).

CREATE TABLE media_browser_reservations (
  user_id TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  reservation_id TEXT NOT NULL,
  job_id TEXT NOT NULL,
  job_attempt INTEGER,
  garment_id TEXT,
  query_hash TEXT,
  attempt_id TEXT,
  seconds INTEGER NOT NULL CHECK (seconds >= 0),
  settled_at TEXT,
  pages_examined INTEGER,
  pages_json TEXT,
  browser_sessions INTEGER,
  detail TEXT,
  retryable INTEGER CHECK (retryable IN (0, 1)),
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (user_id, reservation_id)
);

CREATE INDEX media_browser_reservations_open ON media_browser_reservations (user_id, expires_at);
CREATE INDEX media_browser_reservations_garment ON media_browser_reservations (user_id, garment_id);
