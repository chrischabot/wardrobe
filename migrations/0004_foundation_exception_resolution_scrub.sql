-- Foundation migration 0004: how a laundry exception ended, and scrubbed command records.
--
-- 1. A resolved laundry exception records WHY it is no longer open and which command closed it, so an
--    exception withdrawn by an undo is distinguishable from one the laundry actually settled, and an undo
--    can check that it is reversing exactly what its own command did.
--      resolution: 'returned'          the units it held came back (owner observation)
--                  'with_owner'        an owner observation (worn, marked dirty) showed the unit is with him
--                  'inferred_baseline' a later weekly baseline released the missed cycle (inferred)
--                  'reported_lost'     superseded by a report that the unit is lost
--                  'withdrawn'         the command that created it was undone
ALTER TABLE laundry_exceptions ADD COLUMN resolution TEXT;
ALTER TABLE laundry_exceptions ADD COLUMN resolved_by_command_id TEXT;

-- 2. Forgetting a conversation source removes its text from the command ledger's own copies (request
--    payload, receipt prose, undo data, effect and outbox payloads, action intents). The command row stays,
--    with its type, identifiers, versions and outcome; these columns say that it was scrubbed and by which
--    command, so a receipt never claims more than what is left.
ALTER TABLE commands ADD COLUMN scrubbed_at TEXT;
ALTER TABLE commands ADD COLUMN scrubbed_by_command_id TEXT;
