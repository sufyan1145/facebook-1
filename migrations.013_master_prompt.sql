-- Lets each schedule carry custom instructions (tone, style, visual preferences)
-- that get woven into every script/visual-prompt generation for that schedule.
ALTER TABLE content_schedules
  ADD COLUMN IF NOT EXISTS master_prompt TEXT;
