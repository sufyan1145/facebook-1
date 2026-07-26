-- Lets an admin hide specific dashboard sections/nav items for individual
-- users (e.g. a user who should only use the Content Pipeline and never see
-- the standalone Video Generator).
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS disabled_sections JSONB NOT NULL DEFAULT '[]';
