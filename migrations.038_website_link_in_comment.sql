-- Website Automation: optionally put the article link in the first Facebook comment / an X reply
-- instead of inside the post itself (posts with a link in the body reach fewer people).
ALTER TABLE website_schedules ADD COLUMN IF NOT EXISTS share_fb_link_comment BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE website_schedules ADD COLUMN IF NOT EXISTS share_x_link_reply BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE website_posts ADD COLUMN IF NOT EXISTS share_fb_link_comment BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE website_posts ADD COLUMN IF NOT EXISTS share_x_link_reply BOOLEAN NOT NULL DEFAULT false;
