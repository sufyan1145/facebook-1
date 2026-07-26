-- Monthly video-generation credit system.
-- 45,000 credits/month per account; 1.5 credits per second of generated video
-- (10s = 15 credits, 20s = 30 credits), shared across Content Pipeline and the
-- standalone Video Generator.
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS credits_remaining INTEGER NOT NULL DEFAULT 45000,
  ADD COLUMN IF NOT EXISTS credits_reset_at TIMESTAMPTZ NOT NULL DEFAULT (now() + interval '30 days');

-- Ledger of every charge/refund, for auditing and for showing usage history.
CREATE TABLE IF NOT EXISTS credit_transactions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  amount INTEGER NOT NULL, -- negative = charge, positive = refund/reset
  reason VARCHAR(50) NOT NULL, -- 'pipeline_video', 'video_generator', 'refund', 'monthly_reset'
  seconds NUMERIC(10,2),
  reference_id UUID, -- content_schedule_runs.id or video_gen_jobs.id, when applicable
  balance_after INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_credit_transactions_user ON credit_transactions (user_id, created_at DESC);

-- Video Generator: adds a Vertex Veo3 (own billing, native audio/voice) provider
-- option alongside the existing Kie.ai one, and tracks credit charges.
ALTER TABLE video_gen_jobs
  ADD COLUMN IF NOT EXISTS provider VARCHAR(20) NOT NULL DEFAULT 'kie', -- 'kie' or 'vertex'
  ADD COLUMN IF NOT EXISTS requested_duration_seconds INTEGER,
  ADD COLUMN IF NOT EXISTS credits_charged INTEGER;
