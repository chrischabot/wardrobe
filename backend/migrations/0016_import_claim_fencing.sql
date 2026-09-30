-- Fencing for import claims (the stalled-importer case). Every write batch of an import carries a
-- precondition that fails the whole batch unless the importer still holds its claim, and the same
-- batch refreshes claimed_at (a heartbeat) and counts the batch in `writes`. A claim may be taken over
-- only when its importer has written nothing (writes = 0) and has been silent past the takeover window,
-- so a superseded importer can never write, and a claim is never taken over from an import that
-- has already written rows.
ALTER TABLE import_claims ADD COLUMN writes INTEGER NOT NULL DEFAULT 0;
