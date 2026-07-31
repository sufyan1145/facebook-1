-- Fixes duplicate YouTube uploads: BullMQ retries the whole upload job on any
-- failure (attempts: 5), and there was no column tracking whether the
-- YouTube step had already succeeded on an earlier attempt - so a retry after
-- a late failure (e.g. in bookkeeping, after YouTube upload had already
-- succeeded) would upload the same video to YouTube again.
ALTER TABLE upload_history
  ADD COLUMN IF NOT EXISTS youtube_video_id TEXT;
