CREATE TABLE IF NOT EXISTS kaizen_trade_rooms (
  id BIGSERIAL PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  password_hash TEXT,
  creator_key TEXT NOT NULL REFERENCES kaizen_accounts(username_key) ON DELETE CASCADE,
  partner_key TEXT REFERENCES kaizen_accounts(username_key) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','trading','completed','cancelled')),
  offers JSONB NOT NULL DEFAULT '{}'::jsonb,
  confirmations JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS kaizen_trade_rooms_open_idx ON kaizen_trade_rooms(status, created_at DESC);
CREATE TABLE IF NOT EXISTS kaizen_gacha_daily_banners (
  banner_date TEXT PRIMARY KEY,
  selection JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
