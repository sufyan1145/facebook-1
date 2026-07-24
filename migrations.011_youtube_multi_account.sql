-- Support multiple YouTube channels (each its own separate Google login) per app user,
-- mirroring the existing multi-Facebook-account pattern.

CREATE TABLE IF NOT EXISTS youtube_tokens (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  google_user_id VARCHAR(255) NOT NULL,
  google_user_email VARCHAR(255),
  channel_title VARCHAR(255),
  access_token TEXT NOT NULL,
  refresh_token TEXT,
  expiry_time TIMESTAMPTZ,
  scope TEXT,
  connected_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, google_user_id)
);

-- Which connected YouTube channel (if any) a content schedule should also post to.
ALTER TABLE content_schedules
  ADD COLUMN IF NOT EXISTS youtube_token_id UUID REFERENCES youtube_tokens(id) ON DELETE SET NULL;
