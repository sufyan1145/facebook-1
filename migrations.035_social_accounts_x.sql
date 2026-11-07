-- Social Accounts: X (Twitter) accounts connected through browser cookies,
-- plus "share to social" targets for Website Automation. Idempotent.

CREATE TABLE IF NOT EXISTS x_accounts (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  username TEXT NOT NULL,
  display_name TEXT,
  x_user_id TEXT,
  auth_token TEXT NOT NULL,   -- encrypted
  ct0 TEXT NOT NULL,          -- encrypted
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'expired')),
  last_error TEXT,
  last_used_at TIMESTAMPTZ,
  connected_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_x_accounts_user_name ON x_accounts(user_id, lower(username));

-- Where to share each finished article (Facebook pages.id / x_accounts.id).
ALTER TABLE website_schedules ADD COLUMN IF NOT EXISTS share_page_ids UUID[];
ALTER TABLE website_schedules ADD COLUMN IF NOT EXISTS share_x_ids UUID[];
ALTER TABLE website_posts ADD COLUMN IF NOT EXISTS share_page_ids UUID[];
ALTER TABLE website_posts ADD COLUMN IF NOT EXISTS share_x_ids UUID[];
ALTER TABLE website_posts ADD COLUMN IF NOT EXISTS share_note TEXT;
