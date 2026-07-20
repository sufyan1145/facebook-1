-- ==============================================
-- Add missing interval_hours column (for repeat_type = 'interval_hours')
-- ==============================================

ALTER TABLE schedules ADD COLUMN IF NOT EXISTS interval_hours INT;
