-- Pages added by pasting a Page access token (no Facebook login needed). Idempotent.
ALTER TABLE pages ADD COLUMN IF NOT EXISTS token_added BOOLEAN NOT NULL DEFAULT FALSE;
