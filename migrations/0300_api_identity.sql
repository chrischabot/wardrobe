-- Garderobe API, MCP and identity schema (api-mcp-identity workstream, range 0300-0399).
--
-- Specification sections 13 and 15. Rules kept from the base schema: every personal record carries
-- user_id with owner-qualified keys. Secrets are never stored in clear: invitation codes, link codes,
-- recovery credentials, download tickets, OAuth states and confirmation tokens are stored as hashes or
-- PBKDF2 verifiers only; third-party credentials are stored as AES-256-GCM ciphertext under a Worker
-- secret key that is not in this database.

-- ---------------------------------------------------------------------------------------------
-- Owner admission: explicit invitation/claim (no public signup, no email matching)
-- ---------------------------------------------------------------------------------------------
CREATE TABLE owner_invitations (
  invitation_id   TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL REFERENCES users(user_id),
  code_hash       TEXT NOT NULL UNIQUE,
  created_at      TEXT NOT NULL,
  expires_at      TEXT NOT NULL,
  claimed_at      TEXT,
  claimed_issuer  TEXT,
  claimed_subject TEXT
);
CREATE INDEX owner_invitations_user ON owner_invitations(user_id);

-- An authenticated owner links a second identity in advance with a one-time ticket.
CREATE TABLE identity_link_tickets (
  ticket_id   TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(user_id),
  code_hash   TEXT NOT NULL UNIQUE,
  created_at  TEXT NOT NULL,
  expires_at  TEXT NOT NULL,
  used_at     TEXT
);
CREATE INDEX identity_link_tickets_user ON identity_link_tickets(user_id);

-- Sessions authenticated before `not_before` are refused for the account (recovery, sign-out-everywhere).
CREATE TABLE auth_session_floors (
  user_id     TEXT PRIMARY KEY REFERENCES users(user_id),
  not_before  TEXT NOT NULL,
  reason      TEXT NOT NULL,
  -- The identity whose session performed the revocation keeps working from its own sign-in time
  -- (hash of issuer and subject); every other session older than not_before is refused.
  exempt_identity_hash TEXT,
  exempt_not_before    TEXT,
  updated_at  TEXT NOT NULL
);

-- ---------------------------------------------------------------------------------------------
-- Account recovery (only a verifier of the one-time credential is stored)
-- ---------------------------------------------------------------------------------------------
CREATE TABLE recovery_credentials (
  user_id      TEXT NOT NULL REFERENCES users(user_id),
  kit_id       TEXT NOT NULL UNIQUE,
  verifier     TEXT NOT NULL,
  salt         TEXT NOT NULL,
  algorithm    TEXT NOT NULL,
  status       TEXT NOT NULL CHECK (status IN ('active', 'used', 'replaced')),
  created_at   TEXT NOT NULL,
  retired_at   TEXT,
  PRIMARY KEY (user_id, kit_id)
);
-- At most one active credential per owner.
CREATE UNIQUE INDEX recovery_credentials_one_active ON recovery_credentials(user_id) WHERE status = 'active';

-- An expiring recovery transaction is bound to the verified identity that opened it; it names no
-- account until the credential is proven.
CREATE TABLE recovery_transactions (
  transaction_id TEXT PRIMARY KEY,
  issuer         TEXT NOT NULL,
  subject        TEXT NOT NULL,
  display_email  TEXT,
  created_at     TEXT NOT NULL,
  expires_at     TEXT NOT NULL,
  attempts       INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  max_attempts   INTEGER NOT NULL CHECK (max_attempts > 0),
  status         TEXT NOT NULL CHECK (status IN ('open', 'completed', 'failed', 'expired')),
  user_id        TEXT REFERENCES users(user_id),
  completed_at   TEXT
);
CREATE INDEX recovery_transactions_identity ON recovery_transactions(issuer, subject, created_at);

-- Fixed-window counters for authentication-sensitive operations.
CREATE TABLE auth_rate_limits (
  bucket        TEXT NOT NULL,
  window_start  INTEGER NOT NULL,
  count         INTEGER NOT NULL CHECK (count >= 0),
  PRIMARY KEY (bucket, window_start)
);

-- Audit receipts for identity and account operations, including refused attempts that name no account.
-- The subject of the acting identity is stored as a hash; details never contain a secret.
CREATE TABLE account_audit (
  audit_id        TEXT PRIMARY KEY,
  user_id         TEXT REFERENCES users(user_id),
  kind            TEXT NOT NULL,
  outcome         TEXT NOT NULL CHECK (outcome IN ('ok', 'refused')),
  at              TEXT NOT NULL,
  actor_issuer    TEXT,
  actor_subject_hash TEXT,
  channel         TEXT NOT NULL,
  detail_json     TEXT NOT NULL
);
CREATE INDEX account_audit_user ON account_audit(user_id, at);

-- Two-step account deletion (a separate operation from unlinking an identity).
CREATE TABLE account_deletions (
  user_id       TEXT PRIMARY KEY REFERENCES users(user_id),
  token_hash    TEXT NOT NULL,
  requested_at  TEXT NOT NULL,
  expires_at    TEXT NOT NULL,
  confirmed_at  TEXT
);

-- ---------------------------------------------------------------------------------------------
-- Consumer assistant (MCP) grants: the authoritative, immediately revocable record.
-- The Workers OAuth provider keeps its own records in KV; every protected MCP operation also
-- checks this row, so a stale KV token cannot keep a revoked grant effective.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE mcp_grants (
  user_id        TEXT NOT NULL REFERENCES users(user_id),
  grant_id       TEXT NOT NULL,
  client_id      TEXT NOT NULL,
  client_name    TEXT NOT NULL,
  client_uri     TEXT,
  client_domain  TEXT,
  redirect_host  TEXT NOT NULL,
  scopes_json    TEXT NOT NULL,
  status         TEXT NOT NULL CHECK (status IN ('active', 'revoked')),
  version        INTEGER NOT NULL CHECK (version >= 1),
  protocol       TEXT,
  granted_at     TEXT NOT NULL,
  last_used_at   TEXT,
  revoked_at     TEXT,
  revoked_reason TEXT,
  PRIMARY KEY (user_id, grant_id)
);
CREATE INDEX mcp_grants_status ON mcp_grants(user_id, status);

-- ---------------------------------------------------------------------------------------------
-- Runs: registry of durable long operations and the event log of runs this workstream executes
-- (export, import, recommendation). Conversation and research runs are projected from the
-- assistant's durable turn state; their rows here only bind the run ID to its owner and provider.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE api_runs (
  user_id           TEXT NOT NULL REFERENCES users(user_id),
  run_id            TEXT NOT NULL,
  kind              TEXT NOT NULL,
  provider          TEXT NOT NULL CHECK (provider IN ('api', 'assistant')),
  state             TEXT NOT NULL CHECK (state IN ('queued', 'running', 'needs_input', 'completed', 'failed', 'cancelled')),
  client_request_id TEXT,
  request_hash      TEXT,
  channel           TEXT NOT NULL,
  activity          TEXT,
  result_json       TEXT,
  error_json        TEXT,
  receipts_json     TEXT NOT NULL DEFAULT '[]',
  last_event_id     INTEGER NOT NULL DEFAULT 0 CHECK (last_event_id >= 0),
  first_event_id    INTEGER NOT NULL DEFAULT 1 CHECK (first_event_id >= 1),
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  PRIMARY KEY (user_id, run_id)
);
CREATE UNIQUE INDEX api_runs_client_request ON api_runs(user_id, kind, client_request_id) WHERE client_request_id IS NOT NULL;

CREATE TABLE api_run_events (
  user_id    TEXT NOT NULL,
  run_id     TEXT NOT NULL,
  event_id   INTEGER NOT NULL CHECK (event_id >= 1),
  type       TEXT NOT NULL,
  at         TEXT NOT NULL,
  data_json  TEXT NOT NULL,
  PRIMARY KEY (user_id, run_id, event_id),
  FOREIGN KEY (user_id, run_id) REFERENCES api_runs(user_id, run_id)
);

-- ---------------------------------------------------------------------------------------------
-- Third-party connection credentials and authorization transactions.
-- The connection registry itself (endpoint, namespace, tools, status) is the assistant workstream's;
-- its `secretRef` names a row here. Ciphertext only; the key is a Worker secret.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE connection_credentials (
  user_id        TEXT NOT NULL REFERENCES users(user_id),
  secret_ref     TEXT NOT NULL,
  connection_id  TEXT NOT NULL,
  kind           TEXT NOT NULL,
  auth_type      TEXT NOT NULL CHECK (auth_type IN ('oauth', 'secret', 'none')),
  ciphertext     TEXT,
  iv             TEXT,
  key_version    TEXT,
  meta_json      TEXT NOT NULL DEFAULT '{}',
  version        INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at     TEXT NOT NULL,
  rotated_at     TEXT,
  removed_at     TEXT,
  PRIMARY KEY (user_id, secret_ref)
);
CREATE UNIQUE INDEX connection_credentials_connection ON connection_credentials(user_id, connection_id);

-- API-side view of a connection's health and policy (no secrets): what the phone shows.
CREATE TABLE connection_profiles (
  user_id           TEXT NOT NULL REFERENCES users(user_id),
  connection_id     TEXT NOT NULL,
  kind              TEXT NOT NULL CHECK (kind IN ('google_workspace', 'mcp', 'exa', 'tavily')),
  name              TEXT NOT NULL,
  endpoint          TEXT,
  namespace         TEXT NOT NULL,
  protocol          TEXT,
  auth_type         TEXT NOT NULL CHECK (auth_type IN ('oauth', 'secret', 'none')),
  state             TEXT NOT NULL CHECK (state IN ('pending_authorization', 'connected', 'needs_reconnect', 'error', 'disconnected')),
  capabilities_json TEXT NOT NULL,
  expected_issuer   TEXT,
  client_request_id TEXT,
  last_success_at   TEXT,
  last_checked_at   TEXT,
  issue_json        TEXT,
  version           INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  -- Version last mirrored into the assistant's connection registry (0 = never).
  mirrored_version  INTEGER NOT NULL DEFAULT 0,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  PRIMARY KEY (user_id, connection_id)
);
CREATE UNIQUE INDEX connection_profiles_request ON connection_profiles(user_id, client_request_id) WHERE client_request_id IS NOT NULL;
CREATE UNIQUE INDEX connection_profiles_namespace ON connection_profiles(user_id, namespace);

-- One-time, expiring state of a provider authorization redirect. The callback is authenticated by
-- this record alone (bound to the owner and the connection), never by a caller-supplied header.
CREATE TABLE connection_oauth_states (
  state_hash        TEXT PRIMARY KEY,
  user_id           TEXT NOT NULL REFERENCES users(user_id),
  connection_id     TEXT NOT NULL,
  verifier_cipher   TEXT,
  verifier_iv       TEXT,
  redirect_uri      TEXT NOT NULL,
  return_to         TEXT NOT NULL,
  created_at        TEXT NOT NULL,
  expires_at        TEXT NOT NULL,
  used_at           TEXT,
  FOREIGN KEY (user_id, connection_id) REFERENCES connection_profiles(user_id, connection_id)
);

-- ---------------------------------------------------------------------------------------------
-- Portable export and import
-- ---------------------------------------------------------------------------------------------
CREATE TABLE export_jobs (
  user_id           TEXT NOT NULL REFERENCES users(user_id),
  export_id         TEXT NOT NULL,
  run_id            TEXT NOT NULL,
  client_request_id TEXT NOT NULL,
  state             TEXT NOT NULL CHECK (state IN ('queued', 'running', 'completed', 'completed_incomplete', 'failed', 'expired')),
  encrypted         INTEGER NOT NULL CHECK (encrypted IN (0, 1)),
  format_version    TEXT NOT NULL,
  snapshot_json     TEXT,
  components_json   TEXT NOT NULL DEFAULT '[]',
  progress_json     TEXT NOT NULL DEFAULT '{}',
  object_key        TEXT,
  byte_length       INTEGER,
  sha256            TEXT,
  requested_at      TEXT NOT NULL,
  finished_at       TEXT,
  expires_at        TEXT,
  PRIMARY KEY (user_id, export_id),
  UNIQUE (user_id, client_request_id)
);

CREATE TABLE export_tickets (
  ticket_hash  TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL,
  export_id    TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  expires_at   TEXT NOT NULL,
  used_at      TEXT,
  FOREIGN KEY (user_id, export_id) REFERENCES export_jobs(user_id, export_id)
);

CREATE TABLE import_jobs (
  user_id       TEXT NOT NULL REFERENCES users(user_id),
  import_id     TEXT NOT NULL,
  run_id        TEXT NOT NULL,
  state         TEXT NOT NULL CHECK (state IN ('running', 'completed', 'failed', 'rejected')),
  package_sha256 TEXT,
  report_json   TEXT NOT NULL DEFAULT '{}',
  created_at    TEXT NOT NULL,
  finished_at   TEXT,
  PRIMARY KEY (user_id, import_id)
);
