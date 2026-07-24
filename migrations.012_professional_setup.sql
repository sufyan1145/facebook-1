-- Makes Facebook posting optional (so a schedule/content-pipeline run can post to
-- YouTube only), and adds YouTube channel + Shorts/Long-form video type support
-- to the plain "Schedules" (Drive folder -> auto upload) feature, matching what
-- Content Pipeline already has.

ALTER TABLE content_schedules
  ALTER COLUMN page_id DROP NOT NULL,
  ADD COLUMN IF NOT EXISTS post_to_facebook BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS youtube_video_type VARCHAR(20) NOT NULL DEFAULT 'auto';

ALTER TABLE schedules
  ALTER COLUMN page_id DROP NOT NULL,
  ADD COLUMN IF NOT EXISTS post_to_facebook BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS youtube_token_id UUID REFERENCES youtube_tokens(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS youtube_video_type VARCHAR(20) NOT NULL DEFAULT 'auto';
