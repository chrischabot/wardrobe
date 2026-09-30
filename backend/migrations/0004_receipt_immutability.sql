-- Migration 0004 (foundation workstream): command receipts are immutable (ADV-16).
-- Deletion is already blocked in 0001. Updates are blocked too, except the single transition the
-- undo command performs: setting undone_by_command_id once, from NULL, with every other column unchanged.
CREATE TRIGGER command_receipts_no_update BEFORE UPDATE ON command_receipts
WHEN NOT (
  OLD.undone_by_command_id IS NULL
  AND NEW.undone_by_command_id IS NOT NULL
  AND NEW.user_id IS OLD.user_id
  AND NEW.command_id IS OLD.command_id
  AND NEW.idempotency_key IS OLD.idempotency_key
  AND NEW.request_hash IS OLD.request_hash
  AND NEW.command_type IS OLD.command_type
  AND NEW.command_class IS OLD.command_class
  AND NEW.source IS OLD.source
  AND NEW.outcome IS OLD.outcome
  AND NEW.receipt_json IS OLD.receipt_json
  AND NEW.undo_json IS OLD.undo_json
  AND NEW.compensates_command_id IS OLD.compensates_command_id
  AND NEW.occurred_at IS OLD.occurred_at
  AND NEW.recorded_at IS OLD.recorded_at
)
BEGIN
  SELECT RAISE(ABORT, 'command receipts are immutable');
END;
