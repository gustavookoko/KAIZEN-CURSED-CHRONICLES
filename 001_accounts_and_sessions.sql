CREATE TABLE IF NOT EXISTS kaizen_accounts (
  username_key TEXT PRIMARY KEY,
  username TEXT NOT NULL,
  salt TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  progress JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at_text TEXT,
  updated_at_text TEXT,
  daily_claims JSONB NOT NULL DEFAULT '{"date":"","claimed":[]}'::jsonb,
  extra_data JSONB NOT NULL DEFAULT '{}'::jsonb,
  revision BIGINT NOT NULL DEFAULT 1 CHECK (revision >= 1),
  CONSTRAINT kaizen_accounts_username_key_normalized CHECK (username_key = lower(btrim(username)))
);

CREATE UNIQUE INDEX IF NOT EXISTS kaizen_accounts_username_ci_idx
  ON kaizen_accounts (lower(btrim(username))); 

CREATE TABLE IF NOT EXISTS kaizen_sessions (
  token_hash CHAR(64) PRIMARY KEY,
  username_key TEXT NOT NULL REFERENCES kaizen_accounts(username_key) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS kaizen_sessions_user_idx ON kaizen_sessions(username_key);
CREATE INDEX IF NOT EXISTS kaizen_sessions_expiry_idx ON kaizen_sessions(expires_at);
