-- New, self-contained feature: download a TikTok video by URL, optionally
-- save it into a Drive folder, and have Gemini rewrite a fresh title +
-- hashtags for it. Entirely new table - does not touch any existing feature.
CREATE TABLE IF NOT EXISTS tiktok_download_jobs (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source_url TEXT NOT NULL,
  drive_folder_id TEXT,
  drive_folder_name TEXT,
  status VARCHAR(30) NOT NULL DEFAULT 'pending', -- pending, fetching_info, downloading, regenerating_metadata, completed, failed
  drive_file_id TEXT,
  drive_file_name TEXT,
  local_file_path TEXT, -- set instead of drive_file_id when not saved to Drive
  original_title TEXT,
  original_description TEXT,
  generated_title TEXT,
  generated_hashtags TEXT,
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_tiktok_jobs_user ON tiktok_download_jobs (user_id, created_at DESC);
