-- Supports "topic" mode for AI-sourced Text+Image schedules: instead of a fixed
-- prompt/caption repeated every run, a topic drives a freshly generated caption
-- (any language, matching the topic's own language) and a freshly generated
-- image on every scheduled run.
ALTER TABLE text_image_schedules ADD COLUMN IF NOT EXISTS topic TEXT;
