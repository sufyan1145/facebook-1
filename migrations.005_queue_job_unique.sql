-- ==============================================
-- Fix queue_jobs duplicating a row on every retry attempt instead of
-- updating the same row. Add a unique constraint so upserts work.
-- ==============================================

-- Drop any duplicate rows first (keep the most recently updated one per bullmq_job_id)
DELETE FROM queue_jobs a USING queue_jobs b
  WHERE a.bullmq_job_id = b.bullmq_job_id
    AND a.bullmq_job_id IS NOT NULL
    AND a.updated_at < b.updated_at;

ALTER TABLE queue_jobs ADD COLUMN IF NOT EXISTS error_message TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS queue_jobs_bullmq_job_id_key ON queue_jobs (bullmq_job_id);
