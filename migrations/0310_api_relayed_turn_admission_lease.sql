-- API, MCP and identity workstream, migration 0310: enforce relayed-turn admission lease on turn persistence.
--
-- A new relayed MCP conversation turn (`auth_ref LIKE 'mcp:%'`, `kind = 'conversation'`, `status = 'accepted'`)
-- may be persisted in `assistant_turns` only while its pre-dispatch admission in `relayed_turn_admissions`
-- is still within its 60-second lease window (`ADMISSION_LEASE_MS`). If the caller was delayed past lease
-- expiry (and its admission expired or was reconciled away), SQLite aborts the `INSERT INTO assistant_turns`
-- before the turn row can be written or any model step or proposal can run.
CREATE TRIGGER enforce_relayed_turn_admission_lease
BEFORE INSERT ON assistant_turns
WHEN NEW.auth_ref LIKE 'mcp:%' AND NEW.submission_id LIKE 'mcp:%' AND NEW.kind = 'conversation' AND NEW.status = 'accepted'
BEGIN
  SELECT RAISE(ABORT, 'relayed_turn_admission_expired')
   WHERE NOT EXISTS (
     SELECT 1 FROM assistant_turns t
      WHERE t.user_id = NEW.user_id AND t.submission_id = NEW.submission_id
   )
   AND NOT EXISTS (
     SELECT 1 FROM relayed_turn_admissions a
      WHERE a.user_id = NEW.user_id
        AND a.submission_id = NEW.submission_id
        AND unixepoch(a.created_at) + 60 > unixepoch(NEW.created_at)
        AND unixepoch(a.created_at) + 60 > unixepoch('now')
   );
END;
