-- Pinterest accounts (official OAuth, API v5) and "also create a Pin" targets for Website Automation. Idempotent.
CREATE TABLE IF NOT EXISTS pinterest_accounts (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  username TEXT NOT NULL,
  access_token TEXT NOT NULL,          -- encrypted
  refresh_token TEXT,                  -- encrypted
  expires_at TIMESTAMPTZ,
  refresh_expires_at TIMESTAMPTZ,
  board_id TEXT,                       -- the board every Pin of this account goes to
  board_name TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'expired')),
  last_error TEXT,
  last_used_at TIMESTAMPTZ,
  connected_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_pinterest_accounts_user_name ON pinterest_accounts(user_id, lower(username));

ALTER TABLE website_schedules ADD COLUMN IF NOT EXISTS share_pinterest_ids UUID[];
ALTER TABLE website_posts ADD COLUMN IF NOT EXISTS share_pinterest_ids UUID[];
