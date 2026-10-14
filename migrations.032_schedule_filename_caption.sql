-- Per-schedule switch: use the video's file name (cleaned up) as the post
-- description/caption. FALSE by default, so existing schedules behave exactly as before.
ALTER TABLE schedules ADD COLUMN IF NOT EXISTS use_filename_as_caption BOOLEAN NOT NULL DEFAULT FALSE;
