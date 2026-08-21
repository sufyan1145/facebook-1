-- Text + Image Post feature: standalone table, no foreign keys into the video
-- pipeline's tables besides users/pages (read-only references), so it cannot
-- affect existing video upload/schedule behavior.
CREATE TABLE IF NOT EXISTS text_image_posts (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  page_id UUID NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  message TEXT,
  image_source TEXT NOT NULL CHECK (image_source IN ('drive', 'ai')),
  drive_file_id TEXT,
  drive_file_name TEXT,
  ai_prompt TEXT,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'processing', 'success', 'failed')),
  facebook_post_id TEXT,
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_text_image_posts_user ON text_image_posts(user_id, created_at DESC);
