-- Optional per-schedule "re-upload allowed" switch.
-- FALSE (default, matches all existing schedules): a video that was already
-- uploaded successfully is never picked again - exactly the old behaviour.
-- TRUE: once every video in the folder has been uploaded, the schedule starts
-- a new round and re-uploads the least-recently-uploaded videos first.
ALTER TABLE schedules ADD COLUMN IF NOT EXISTS allow_reupload BOOLEAN NOT NULL DEFAULT FALSE;
