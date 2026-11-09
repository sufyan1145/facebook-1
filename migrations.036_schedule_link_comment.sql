-- Schedules: optional "link in the first comment" posted on every video the schedule uploads.
ALTER TABLE schedules ADD COLUMN IF NOT EXISTS comment_text TEXT;
