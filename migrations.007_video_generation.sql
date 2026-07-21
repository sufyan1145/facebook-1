-- ==============================================
-- AI Video Generation (topic -> Kie.ai -> saved to Drive folder)
-- ==============================================

CREATE TABLE IF NOT EXISTS video_gen_jobs (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  drive_folder_id VARCHAR(255) NOT NULL,
  drive_folder_name VARCHAR(255),
  topic TEXT NOT NULL,
  duration VARCHAR(10) DEFAULT '5',
  aspect_ratio VARCHAR(10) DEFAULT '9:16',
  kie_task_id VARCHAR(255),
  status VARCHAR(20) NOT NULL DEFAULT 'pending', -- pending, generating, downloading, completed, failed
  error_message TEXT,
  drive_file_id VARCHAR(255),
  drive_file_name VARCHAR(255),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_video_gen_jobs_user ON video_gen_jobs (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_video_gen_jobs_status ON video_gen_jobs (status) WHERE status IN ('pending', 'generating', 'downloading');
