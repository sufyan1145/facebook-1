-- Instagram accounts connected directly with "Instagram API with Instagram Login" (no Facebook Page needed). Idempotent.
CREATE TABLE IF NOT EXISTS instagram_accounts (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  username TEXT NOT NULL,
  ig_user_id TEXT NOT NULL,
  account_type TEXT,
  access_token TEXT NOT NULL,          -- encrypted, long-lived (60 days, refreshed automatically)
  expires_at TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'expired')),
  last_error TEXT,
  last_used_at TIMESTAMPTZ,
  connected_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_instagram_accounts_user_ig ON instagram_accounts(user_id, ig_user_id);

-- Schedules can post their Reels to a connected Instagram account.
ALTER TABLE schedules ADD COLUMN IF NOT EXISTS instagram_account_id UUID;
