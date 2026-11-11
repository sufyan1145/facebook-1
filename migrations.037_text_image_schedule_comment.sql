-- Text + Image schedules: optional "link in the first comment" posted on every photo post the schedule makes.
ALTER TABLE text_image_schedules ADD COLUMN IF NOT EXISTS comment_text TEXT;
