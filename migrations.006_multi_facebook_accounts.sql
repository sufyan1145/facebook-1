-- ==============================================
-- Support multiple Facebook accounts per app user
-- ==============================================

-- Allow more than one Facebook account per user (was UNIQUE(user_id) only)
ALTER TABLE facebook_tokens DROP CONSTRAINT IF EXISTS facebook_tokens_user_id_key;
ALTER TABLE facebook_tokens ADD COLUMN IF NOT EXISTS fb_user_name VARCHAR(255);
CREATE UNIQUE INDEX IF NOT EXISTS facebook_tokens_user_fbuser_key ON facebook_tokens (user_id, fb_user_id);

-- Track which connected Facebook account each page came from
ALTER TABLE pages ADD COLUMN IF NOT EXISTS facebook_token_id UUID REFERENCES facebook_tokens(id) ON DELETE CASCADE;
