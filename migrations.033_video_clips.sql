-- Video Editor: "Make clips from a long video".
-- video_clip_progress remembers, per user + source video, how far into the
-- video clips have already been cut, so a part that was made once is never
-- made again and the next batch simply continues from there.
CREATE TABLE IF NOT EXISTS video_clip_progress (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source_key TEXT NOT NULL,
  source_url TEXT NOT NULL,
  source_title TEXT,
  source_duration NUMERIC,
  next_start NUMERIC NOT NULL DEFAULT 0,
  parts_made INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, source_key)
);

-- Short human-readable result/progress line for a clip batch job
-- (e.g. "5 clips created: Part 7-11 ...").
ALTER TABLE video_edit_jobs ADD COLUMN IF NOT EXISTS clip_summary TEXT;
