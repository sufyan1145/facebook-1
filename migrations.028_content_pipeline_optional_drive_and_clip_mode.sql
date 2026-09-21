-- Two independent additions to Content Pipeline schedules:
--
-- 1. Makes the Google Drive archive folder OPTIONAL, matching the same
--    "make it optional" pattern already used for page_id in migration
--    012_professional_setup.sql (drop NOT NULL there too). Previously
--    folder_id was NOT NULL, so every Content Pipeline schedule was forced
--    to archive its finished video to Drive even if the user only wanted
--    it posted directly to Facebook/YouTube.
--
-- 2. Adds clip_mode: an optional PER-SCHEDULE override of the global
--    CONTENT_CLIP_MODE env var, so a person can choose per-schedule between
--    the cheaper Veo-intro + Nano Banana mix and a full-AI-video (Veo-only)
--    look, without needing separate env vars/redeploys for each. NULL means
--    "use whatever CONTENT_CLIP_MODE is set to" (unchanged behavior).

ALTER TABLE content_schedules
  ALTER COLUMN folder_id DROP NOT NULL,
  ADD COLUMN IF NOT EXISTS clip_mode VARCHAR(30);
