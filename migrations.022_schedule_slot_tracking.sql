-- Tracks, per schedule, the last date each configured time-slot ("06:00", "18:00",
-- or "daily"/"weekly"/"monthly"/"specific_days") successfully fired.
-- This replaces relying only on the single last_run_at column, which could not tell
-- multiple times-of-day (multiple_times repeat) apart and caused missed/duplicate runs.
ALTER TABLE schedules ADD COLUMN IF NOT EXISTS last_run_slots JSONB NOT NULL DEFAULT '{}'::jsonb;
