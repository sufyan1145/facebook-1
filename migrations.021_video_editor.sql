-- Universal Video Editor: paste any video link (YouTube, TikTok, Snapchat,
-- Instagram, etc. - anything yt-dlp supports), apply professional editing
-- effects, get the edited result back. Entirely new table.
CREATE TABLE IF NOT EXISTS video_edit_jobs (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source_url TEXT NOT NULL,
  secondary_url TEXT, -- for split-screen mode
  effects_json JSONB NOT NULL DEFAULT '{}', -- selected effects + params
  drive_folder_id TEXT,
  drive_folder_name TEXT,
  status VARCHAR(30) NOT NULL DEFAULT 'pending', -- pending, downloading, editing, completed, failed
  drive_file_id TEXT,
  drive_file_name TEXT,
  local_file_path TEXT,
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_video_edit_jobs_user ON video_edit_jobs (user_id, created_at DESC);
