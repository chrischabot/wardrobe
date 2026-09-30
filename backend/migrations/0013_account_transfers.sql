-- Export, import and recovery reached from a connected assistant (owner request 2026-09-29).
--
-- account_transfers: one row per private hand-off. The payload itself never lives here: export
-- packages and staged import packages are private R2 objects whose keys are derived from
-- (user_id, transfer_id); recovery codes are never stored in plaintext anywhere (only the verifier in
-- recovery_credentials, written when the owner collects the kit). Links are HMAC-signed and stateless;
-- no link material is stored.
CREATE TABLE account_transfers (
  user_id TEXT NOT NULL REFERENCES users(user_id),
  transfer_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('export_download', 'import_package', 'recovery_kit_link')),
  status TEXT NOT NULL CHECK (status IN ('ready', 'staged', 'pending', 'collected', 'imported', 'expired')),
  ref TEXT,
  summary_json TEXT NOT NULL DEFAULT '{}',
  surface TEXT NOT NULL,
  grant_ref TEXT,
  idempotency_key TEXT,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  completed_at TEXT,
  PRIMARY KEY (user_id, transfer_id)
);
CREATE INDEX account_transfers_by_kind ON account_transfers (user_id, kind, status);

-- Append-only audit of every export, import and recovery action (requested, refused, delivered,
-- downloaded, collected), with the surface and connection that asked. Never holds payloads or codes.
CREATE TABLE account_audit (
  user_id TEXT NOT NULL REFERENCES users(user_id),
  audit_id TEXT NOT NULL,
  action TEXT NOT NULL,
  surface TEXT NOT NULL,
  grant_ref TEXT,
  idempotency_key TEXT,
  outcome TEXT NOT NULL,
  detail_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  PRIMARY KEY (user_id, audit_id)
);
CREATE INDEX account_audit_by_time ON account_audit (user_id, created_at);
