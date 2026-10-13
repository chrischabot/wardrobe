-- Foundation migration 0003: undoing a laundry pickup marks the batch withdrawn instead of deleting it.
--
-- Undo is a compensating command, never a deletion: the record that a pickup was reported stays, with
-- the command that withdrew it. A withdrawn batch is not an open batch: it is not returned, not inferred
-- returned by the weekly baseline and not listed on the Laundry sheet.

ALTER TABLE laundry_batches ADD COLUMN withdrawn_at TEXT;
ALTER TABLE laundry_batches ADD COLUMN withdrawn_by_command_id TEXT;
