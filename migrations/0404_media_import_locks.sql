-- Visual wardrobe: one import per owner, held atomically.
--
-- A media import into an empty owner first takes this owner-level lock, naming the digest of the whole
-- package and the digest of the import plan (every command and its rows, which depend on which files were
-- verified). Every import command checks inside its commit that the lock still names its package, so two
-- different packages can never be mixed into one owner. A run that continues a stopped import must produce
-- exactly the same plan; if the package's files now read differently, it is refused before anything is
-- written. The lock may be taken over only while the owner still holds no imported records.

CREATE TABLE media_import_locks (
  user_id TEXT NOT NULL PRIMARY KEY REFERENCES users(user_id) ON DELETE CASCADE,
  package_digest TEXT NOT NULL,
  plan_digest TEXT NOT NULL,
  created_at TEXT NOT NULL,
  -- The owner's last command row when the lock was taken: a continuation counts only commands written after it
  -- (ordered by row, not by millisecond timestamps, which commands committed just before the lock can share).
  command_rowid INTEGER NOT NULL DEFAULT 0,
  -- Set once the holding import's records are committed, immediately before its storage clean-up lists the
  -- owner's files. A superseded run whose write lands after this moment removes that write itself (the winner's
  -- listing may have missed it); a write that lands before it is seen and removed by the winner's clean-up.
  cleanup_started_at TEXT
);
