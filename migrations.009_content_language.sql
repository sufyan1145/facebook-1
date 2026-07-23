-- Adds a language field to content_schedules so the AI script/voiceover can be
-- generated in English or Roman Urdu instead of always English.
ALTER TABLE content_schedules
  ADD COLUMN IF NOT EXISTS language VARCHAR(20) NOT NULL DEFAULT 'english';
