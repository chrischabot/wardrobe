-- Garderobe migration 0011: HTTP API, MCP server, inbound OAuth and native app sign-in (API/MCP workstream).
-- New tables and one additive column only; 0001 is frozen. Every private row carries user_id.

-- Outfit calendar chosen in Settings > Morning delivery (update_delivery_settings).
ALTER TABLE owner_settings ADD COLUMN calendar_id TEXT;

-- ---------------------------------------------------------------- consumer MCP grants (Claude, ChatGPT)
-- The Workers OAuth provider keeps its own records in OAUTH_KV. This table is the application's
-- authoritative grant decision: every protected MCP call checks status and version here, so a
-- revoked grant stops immediately even if a KV token record is still cached.
CREATE TABLE mcp_grants (
  user_id TEXT NOT NULL REFERENCES users(user_id),
  grant_id TEXT NOT NULL,
  provider_grant_id TEXT,
  client_id TEXT NOT NULL,
  client_kind TEXT NOT NULL CHECK (client_kind IN ('claude', 'chatgpt', 'other')),
  client_name TEXT NOT NULL,
  redirect_host TEXT NOT NULL,
  scopes_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'revoked')),
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  revoked_at TEXT,
  revoked_reason TEXT,
  last_used_at TEXT,
  last_operation TEXT,
  -- Protocol revision last used by this connection ('2026-07-28' or the 2025-11-25 compatibility adapter).
  last_protocol TEXT,
  PRIMARY KEY (user_id, grant_id)
);
CREATE INDEX mcp_grants_by_client ON mcp_grants (user_id, client_kind, status);

-- ---------------------------------------------------------------- run event projection (SSE)
-- Ordered, replayable events per run. Derived from the durable run state (Think turn ledger,
-- receipts); never a second canonical conversation store. Retention is bounded: pruned events
-- make an older cursor receive a snapshot instead of a silent gap.
CREATE TABLE run_events (
  user_id TEXT NOT NULL REFERENCES users(user_id),
  run_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  event_key TEXT NOT NULL,
  type TEXT NOT NULL,
  data_json TEXT NOT NULL,
  at TEXT NOT NULL,
  PRIMARY KEY (user_id, run_id, seq),
  UNIQUE (user_id, run_id, event_key)
);
CREATE INDEX runs_by_parent ON runs (user_id, parent_ref);
CREATE INDEX runs_by_kind ON runs (user_id, kind, created_at);

-- ---------------------------------------------------------------- pending actions (MRTR / native questions)
-- One durable record per request for owner input. An MCP input_required retry and a native answer
-- resolve the same row; the stored envelope (idempotency key, expected versions, request hash) is
-- what executes, so a repeated, altered or expired answer can never duplicate an effect.
CREATE TABLE pending_actions (
  user_id TEXT NOT NULL REFERENCES users(user_id),
  pending_id TEXT NOT NULL,
  run_id TEXT,
  surface TEXT NOT NULL CHECK (surface IN ('mcp', 'app', 'web', 'conversation')),
  kind TEXT NOT NULL,
  prompt TEXT NOT NULL,
  choices_json TEXT NOT NULL DEFAULT '[]',
  envelope_json TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  grant_ref TEXT,
  status TEXT NOT NULL CHECK (status IN ('pending', 'resolved', 'expired', 'cancelled')),
  response_json TEXT,
  command_id TEXT,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  resolved_at TEXT,
  PRIMARY KEY (user_id, pending_id),
  UNIQUE (user_id, idempotency_key, kind)
);

-- ---------------------------------------------------------------- native app sign-in (public PKCE client)
-- Local stand-in for Access Managed OAuth: authorization codes bound to a verified Access identity,
-- PKCE S256 and the API resource; opaque short-lived access tokens and rotating refresh tokens.
-- Only SHA-256 hashes of codes and tokens are stored.
CREATE TABLE native_auth_codes (
  code_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(user_id),
  client_id TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  code_challenge TEXT NOT NULL,
  resource TEXT NOT NULL,
  scope TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE app_sessions (
  user_id TEXT NOT NULL REFERENCES users(user_id),
  session_id TEXT NOT NULL,
  client_id TEXT NOT NULL,
  scope TEXT NOT NULL,
  access_hash TEXT NOT NULL UNIQUE,
  access_expires_at TEXT NOT NULL,
  refresh_hash TEXT NOT NULL UNIQUE,
  previous_refresh_hash TEXT,
  refresh_expires_at TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'revoked')),
  revoked_reason TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_used_at TEXT,
  PRIMARY KEY (user_id, session_id)
);
CREATE INDEX app_sessions_prev_refresh ON app_sessions (previous_refresh_hash);
