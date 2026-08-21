-- Scheduling for the Text + Image Post feature - separate table, same proven
-- structure as `schedules` (last_run_slots for atomic per-slot claiming so no
-- run is ever missed or double-fired, same repeat_type options).
CREATE TABLE IF NOT EXISTS text_image_schedules (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  page_id UUID NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  message TEXT,
  image_source TEXT NOT NULL CHECK (image_source IN ('drive', 'ai')),
  folder_id UUID REFERENCES drive_folders(id) ON DELETE SET NULL,
  ai_prompt TEXT,
  upload_time TEXT NOT NULL, -- 'HH:MM', used for daily/weekly/monthly/specific_days
  timezone TEXT NOT NULL DEFAULT 'UTC',
  repeat_type TEXT NOT NULL CHECK (repeat_type IN ('daily', 'weekly', 'monthly', 'specific_days', 'interval_hours', 'multiple_times')),
  specific_days INTEGER[],
  interval_hours INTEGER,
  times JSONB, -- array of 'HH:MM' strings, used for multiple_times
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  last_run_at TIMESTAMPTZ,
  last_run_slots JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_text_image_schedules_user ON text_image_schedules(user_id, created_at DESC);

-- Lets a scheduled run's history row point back to the schedule that created it
-- (nullable - manual one-off posts leave this NULL). ON DELETE SET NULL so
-- deleting a schedule never deletes its past post history.
ALTER TABLE text_image_posts ADD COLUMN IF NOT EXISTS schedule_id UUID REFERENCES text_image_schedules(id) ON DELETE SET NULL;
