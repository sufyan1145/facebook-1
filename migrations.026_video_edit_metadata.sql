-- Supports the Video Editor's new "Regenerate title" option (AI rewrites the
-- source video's original title/description - any language - into a catchy
-- English title + matching hashtags), matching the pattern tiktok_jobs already uses.
ALTER TABLE video_edit_jobs ADD COLUMN IF NOT EXISTS generated_title TEXT;
ALTER TABLE video_edit_jobs ADD COLUMN IF NOT EXISTS generated_hashtags TEXT;
