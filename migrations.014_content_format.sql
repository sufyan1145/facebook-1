-- Lets each schedule pick a content format (documentary, tutorial, tips list,
-- talking-head vlog, etc.) instead of every video always being framed as a
-- documentary, regardless of the topic.
ALTER TABLE content_schedules
  ADD COLUMN IF NOT EXISTS content_format VARCHAR(30) NOT NULL DEFAULT 'documentary';
