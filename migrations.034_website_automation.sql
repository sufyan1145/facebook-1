-- Website Automation: AI-written articles published to WordPress / Blogger,
-- with optional schedules (same repeat options as the video / text+image schedules).
-- All statements are idempotent.

-- A connected website (WordPress site or Blogger blog).
CREATE TABLE IF NOT EXISTS website_accounts (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  platform TEXT NOT NULL CHECK (platform IN ('wordpress', 'blogger')),
  name TEXT NOT NULL,
  site_url TEXT,
  -- WordPress (Application Password, encrypted)
  wp_username TEXT,
  wp_app_password TEXT,
  -- Blogger (Google OAuth, encrypted)
  blog_id TEXT,
  google_user_email TEXT,
  access_token TEXT,
  refresh_token TEXT,
  expiry_time TIMESTAMPTZ,
  scope TEXT,
  connected_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_website_accounts_user ON website_accounts(user_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_website_accounts_blog ON website_accounts(user_id, blog_id) WHERE blog_id IS NOT NULL;

-- Auto-writing schedules: every run writes a NEW article on the topic.
CREATE TABLE IF NOT EXISTS website_schedules (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  account_id UUID NOT NULL REFERENCES website_accounts(id) ON DELETE CASCADE,
  topic TEXT NOT NULL,
  language TEXT NOT NULL DEFAULT 'english',
  article_length TEXT NOT NULL DEFAULT 'medium' CHECK (article_length IN ('short', 'medium', 'long')),
  image_count INTEGER NOT NULL DEFAULT 3,
  publish_mode TEXT NOT NULL DEFAULT 'publish' CHECK (publish_mode IN ('publish', 'draft')),
  upload_time TEXT NOT NULL,
  timezone TEXT NOT NULL DEFAULT 'UTC',
  repeat_type TEXT NOT NULL CHECK (repeat_type IN ('daily', 'weekly', 'monthly', 'specific_days', 'interval_hours', 'multiple_times')),
  specific_days INTEGER[],
  interval_hours INTEGER,
  times JSONB,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  last_run_at TIMESTAMPTZ,
  last_run_slots JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_website_schedules_user ON website_schedules(user_id, created_at DESC);

-- History: one row per article (manual or scheduled).
CREATE TABLE IF NOT EXISTS website_posts (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  account_id UUID REFERENCES website_accounts(id) ON DELETE SET NULL,
  schedule_id UUID REFERENCES website_schedules(id) ON DELETE SET NULL,
  topic TEXT NOT NULL,
  language TEXT NOT NULL DEFAULT 'english',
  article_length TEXT NOT NULL DEFAULT 'medium',
  image_count INTEGER NOT NULL DEFAULT 3,
  publish_mode TEXT NOT NULL DEFAULT 'publish',
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'writing', 'images', 'publishing', 'published', 'draft', 'failed')),
  title TEXT,
  url TEXT,
  excerpt TEXT,
  image_note TEXT,
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_website_posts_user ON website_posts(user_id, created_at DESC);
