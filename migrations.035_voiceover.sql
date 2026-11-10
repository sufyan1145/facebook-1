-- Voice Over tool: text-to-speech jobs + cloned voices. Idempotent.

CREATE TABLE IF NOT EXISTS voiceover_jobs (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  mode TEXT NOT NULL DEFAULT 'tts' CHECK (mode IN ('tts', 'clone')),
  title TEXT,
  language_code TEXT NOT NULL,
  voice_name TEXT,           -- e.g. en-US-Chirp3-HD-Charon (tts)
  clone_id UUID,             -- voice_clones.id (clone mode)
  voice_label TEXT,
  speaking_rate NUMERIC(4,2) NOT NULL DEFAULT 1.0,
  pitch_semitones NUMERIC(4,1) NOT NULL DEFAULT 0,
  char_count INTEGER NOT NULL DEFAULT 0,
  est_minutes NUMERIC(6,1),
  chunks_total INTEGER NOT NULL DEFAULT 0,
  chunks_done INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'completed', 'failed')),
  file_path TEXT,
  duration_seconds NUMERIC(8,1),
  file_bytes BIGINT,
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_voiceover_jobs_user ON voiceover_jobs(user_id, created_at DESC);

-- A cloned voice is only the opaque key Google returns (stored encrypted).
CREATE TABLE IF NOT EXISTS voice_clones (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  language_code TEXT NOT NULL,
  voice_key TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_voice_clones_user ON voice_clones(user_id, created_at DESC);
