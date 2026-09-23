-- Supports the Video Editor's new "Explain this video" action: paste any
-- video link and get back an exact, chronological AI description of what
-- happens in it (services.vertexAiService.js explainVideo). Reuses the
-- existing video_edit_jobs table/pipeline (download -> analyze -> done) -
-- these jobs never produce an output video file, so drive_file_id/
-- local_file_path stay null; the result lives in this new column instead.
ALTER TABLE video_edit_jobs ADD COLUMN IF NOT EXISTS generated_explanation TEXT;
