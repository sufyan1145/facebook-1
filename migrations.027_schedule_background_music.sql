-- Adds an optional "mute original audio + auto-add background music" step
-- to scheduled uploads. When enabled, the music track is picked at random
-- (each run) from a Google Drive folder the user points at - reusing the
-- same Drive-folder pattern already used for video source folders, rather
-- than building a separate file-upload system.
ALTER TABLE schedules ADD COLUMN IF NOT EXISTS auto_background_music BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE schedules ADD COLUMN IF NOT EXISTS music_folder_id TEXT;
