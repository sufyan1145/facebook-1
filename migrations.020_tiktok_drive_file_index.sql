-- Speeds up looking up a TikTok download job by its Drive file, used to apply
-- the AI-regenerated title/hashtags as the caption when that same video is
-- later posted to Facebook/YouTube by the existing schedule pipeline.
CREATE INDEX IF NOT EXISTS idx_tiktok_jobs_drive_file ON tiktok_download_jobs (drive_file_id) WHERE drive_file_id IS NOT NULL;
