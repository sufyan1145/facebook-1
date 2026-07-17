-- ==============================================
-- Drive2Facebook Automation - Initial Schema
-- ==============================================
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- USERS
CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name VARCHAR(150) NOT NULL,
  email VARCHAR(255) UNIQUE NOT NULL,
  password_hash VARCHAR(255),
  is_email_verified BOOLEAN DEFAULT FALSE,
  email_verify_token VARCHAR(255),
  password_reset_token VARCHAR(255),
  password_reset_expires TIMESTAMPTZ,
  google_id VARCHAR(255) UNIQUE,
  avatar_url TEXT,
  timezone VARCHAR(100) DEFAULT 'UTC',
  language VARCHAR(10) DEFAULT 'en',
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- GOOGLE TOKENS
CREATE TABLE IF NOT EXISTS google_tokens (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  access_token TEXT NOT NULL,
  refresh_token TEXT,
  expiry_time TIMESTAMPTZ,
  scope TEXT,
  connected_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(user_id)
);

-- FACEBOOK TOKENS
CREATE TABLE IF NOT EXISTS facebook_tokens (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  access_token TEXT NOT NULL,
  token_type VARCHAR(50) DEFAULT 'long_lived',
  expiry_time TIMESTAMPTZ,
  fb_user_id VARCHAR(100),
  connected_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(user_id)
);

-- FACEBOOK PAGES
CREATE TABLE IF NOT EXISTS pages (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  page_id VARCHAR(100) NOT NULL,
  page_name VARCHAR(255) NOT NULL,
  followers INT DEFAULT 0,
  page_access_token TEXT NOT NULL,
  is_connected BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(user_id, page_id)
);

-- DRIVE FOLDERS
CREATE TABLE IF NOT EXISTS drive_folders (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  folder_id VARCHAR(255) NOT NULL,
  folder_name VARCHAR(500) NOT NULL,
  video_count INT DEFAULT 0,
  storage_bytes BIGINT DEFAULT 0,
  owner_email VARCHAR(255),
  last_modified TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(user_id, folder_id)
);

-- FOLDER MAPPING (Page <-> Drive Folder)
CREATE TABLE IF NOT EXISTS folder_mapping (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  page_id UUID NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  folder_id UUID NOT NULL REFERENCES drive_folders(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(page_id, folder_id)
);

-- SCHEDULES
CREATE TABLE IF NOT EXISTS schedules (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  page_id UUID NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  folder_id UUID NOT NULL REFERENCES drive_folders(id) ON DELETE CASCADE,
  upload_time VARCHAR(5) NOT NULL, -- HH:mm
  timezone VARCHAR(100) NOT NULL DEFAULT 'UTC',
  repeat_type VARCHAR(20) NOT NULL DEFAULT 'daily', -- daily, weekly, monthly, specific_days
  specific_days INT[], -- 0-6 (Sun-Sat) when repeat_type = specific_days
  max_uploads INT DEFAULT 1,
  random_delay_seconds INT DEFAULT 0,
  caption TEXT,
  hashtags TEXT,
  privacy VARCHAR(20) DEFAULT 'PUBLISHED', -- PUBLISHED / SCHEDULED
  publish_immediately BOOLEAN DEFAULT TRUE,
  is_active BOOLEAN DEFAULT TRUE,
  last_run_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- QUEUE (mirror of BullMQ jobs for UI visibility)
CREATE TABLE IF NOT EXISTS queue_jobs (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  schedule_id UUID REFERENCES schedules(id) ON DELETE SET NULL,
  bullmq_job_id VARCHAR(255),
  status VARCHAR(20) DEFAULT 'waiting', -- waiting, active, completed, failed, delayed, paused, cancelled
  attempts INT DEFAULT 0,
  max_attempts INT DEFAULT 5,
  error_message TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- UPLOAD HISTORY
CREATE TABLE IF NOT EXISTS upload_history (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  schedule_id UUID REFERENCES schedules(id) ON DELETE SET NULL,
  drive_file_id VARCHAR(255) NOT NULL,
  video_name VARCHAR(500),
  facebook_page_id VARCHAR(100),
  facebook_video_id VARCHAR(100),
  drive_folder_name VARCHAR(500),
  duration_seconds INT,
  file_hash VARCHAR(128),
  status VARCHAR(20) DEFAULT 'pending', -- pending, uploading, success, failed, retrying
  uploaded_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(drive_file_id, facebook_page_id)
);

-- LOGS (activity log)
CREATE TABLE IF NOT EXISTS logs (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  action VARCHAR(255) NOT NULL, -- e.g. "Drive Connected", "Schedule Created"
  details JSONB,
  level VARCHAR(20) DEFAULT 'info', -- info, warning, error
  created_at TIMESTAMPTZ DEFAULT now()
);

-- NOTIFICATIONS
CREATE TABLE IF NOT EXISTS notifications (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type VARCHAR(50) NOT NULL, -- success, failure, retry, info
  title VARCHAR(255) NOT NULL,
  message TEXT,
  is_read BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- SETTINGS
CREATE TABLE IF NOT EXISTS settings (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  email_alerts BOOLEAN DEFAULT TRUE,
  auto_retry BOOLEAN DEFAULT TRUE,
  upload_speed VARCHAR(20) DEFAULT 'normal',
  queue_size INT DEFAULT 5,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_schedules_user ON schedules(user_id);
CREATE INDEX IF NOT EXISTS idx_upload_history_user ON upload_history(user_id);
CREATE INDEX IF NOT EXISTS idx_logs_user ON logs(user_id);
CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id);
CREATE INDEX IF NOT EXISTS idx_queue_jobs_user ON queue_jobs(user_id);
