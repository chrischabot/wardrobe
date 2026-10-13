-- Daily service: every choice on a board (select, clear, or the undo of either) advances selection_version,
-- and so does a board revision that drops the choice because its option is no longer offered.
-- A choice pins the version it read and an undo pins the version its choice wrote, so two concurrent
-- choices cannot both commit, and undoing an older choice never overwrites a newer one - even when the
-- newer one wrote the same values (two successive clears, or the same option chosen twice).
ALTER TABLE boards ADD COLUMN selection_version INTEGER NOT NULL DEFAULT 0;
