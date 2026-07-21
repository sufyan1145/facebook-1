-- ==============================================
-- Fully automated content pipeline: keyword -> AI script -> AI voiceover ->
-- AI video clips -> stitched together -> saved to Drive -> posted to Facebook
-- ==============================================

CREATE TABLE IF NOT EXISTS content_schedules (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  page_id UUID NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  folder_id UUID NOT NULL REFERENCES drive_folders(id) ON DELETE CASCADE, -- where the finished video is archived

  keyword TEXT NOT NULL,
  target_duration_seconds INT NOT NULL DEFAULT 60,
  voice_name VARCHAR(100) DEFAULT 'Kore',

  upload_time VARCHAR(5) NOT NULL, -- HH:mm
  timezone VARCHAR(100) NOT NULL DEFAULT 'UTC',
  repeat_type VARCHAR(20) NOT NULL DEFAULT 'daily', -- daily, weekly, monthly, specific_days, interval_hours, multiple_times
  specific_days INT[],
  interval_hours INT,
  times JSONB,

  caption TEXT,
  hashtags TEXT,
  publish_immediately BOOLEAN DEFAULT TRUE,
  is_active BOOLEAN DEFAULT TRUE,
  last_run_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- One row per actual run, so progress/failures are visible in the UI
CREATE TABLE IF NOT EXISTS content_schedule_runs (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  content_schedule_id UUID NOT NULL REFERENCES content_schedules(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status VARCHAR(30) NOT NULL DEFAULT 'pending',
  -- pending, writing_script, generating_voiceover, generating_clips, stitching, uploading_drive, posting_facebook, completed, failed
  topic TEXT,
  error_message TEXT,
  drive_file_id VARCHAR(255),
  fb_video_id VARCHAR(255),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_content_schedules_user ON content_schedules (user_id);
CREATE INDEX IF NOT EXISTS idx_content_schedule_runs_user ON content_schedule_runs (user_id, created_at DESC);
