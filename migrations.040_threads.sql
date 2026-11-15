-- Threads accounts (official Threads API, OAuth) and "also post on Threads" targets for Website Automation. Idempotent.
CREATE TABLE IF NOT EXISTS threads_accounts (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  username TEXT NOT NULL,
  threads_user_id TEXT NOT NULL,
  access_token TEXT NOT NULL,          -- encrypted, long-lived (60 days, refreshed automatically)
  expires_at TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'expired')),
  last_error TEXT,
  last_used_at TIMESTAMPTZ,
  connected_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_threads_accounts_user_name ON threads_accounts(user_id, lower(username));

ALTER TABLE website_schedules ADD COLUMN IF NOT EXISTS share_threads_ids UUID[];
ALTER TABLE website_schedules ADD COLUMN IF NOT EXISTS share_threads_link_reply BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE website_posts ADD COLUMN IF NOT EXISTS share_threads_ids UUID[];
ALTER TABLE website_posts ADD COLUMN IF NOT EXISTS share_threads_link_reply BOOLEAN NOT NULL DEFAULT false;
