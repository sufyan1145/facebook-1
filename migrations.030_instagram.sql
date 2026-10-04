-- Instagram posting support, added the same way YouTube was: an extra
-- optional toggle on the existing Facebook-page-based schedule, not a
-- separate connection flow. An Instagram Business/Creator account is always
-- linked to a Facebook Page, so no new "connect Instagram" OAuth step is
-- needed - we just also read each page's linked instagram_business_account
-- via the Graph API (same Page Access Token already stored) and store it here.
ALTER TABLE pages ADD COLUMN IF NOT EXISTS instagram_business_account_id TEXT;
ALTER TABLE pages ADD COLUMN IF NOT EXISTS instagram_username TEXT;

ALTER TABLE schedules ADD COLUMN IF NOT EXISTS post_to_instagram BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE upload_history ADD COLUMN IF NOT EXISTS instagram_media_id TEXT;
