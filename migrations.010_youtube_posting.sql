-- Adds an optional YouTube (Shorts) auto-posting toggle alongside Facebook posting.
ALTER TABLE content_schedules
  ADD COLUMN IF NOT EXISTS post_to_youtube BOOLEAN NOT NULL DEFAULT false;
