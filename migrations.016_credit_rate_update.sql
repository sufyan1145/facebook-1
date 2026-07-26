-- Rate/quota update: 20,000 credits/month (was 45,000). Pipeline videos are
-- 2 credits/sec (10s = 20 credits); Video Generator (Vertex Veo3, real
-- per-second Google billing) is 18.75 credits/sec (8s = 150 credits) - set in
-- utils.credits.js, not the database, but the monthly total and existing
-- balances need updating here.
--
-- migrate-runner.js re-runs every migrations.*.sql file on every `npm run
-- migrate`, so this one-time reset is guarded by a marker table to avoid
-- wiping everyone's balance back to 20,000 on every future migration run.
CREATE TABLE IF NOT EXISTS migration_markers (
  id TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM migration_markers WHERE id = 'credit_rate_update_v1') THEN
    ALTER TABLE users ALTER COLUMN credits_remaining SET DEFAULT 20000;

    UPDATE users SET credits_remaining = 20000, credits_reset_at = now() + interval '30 days';

    INSERT INTO credit_transactions (user_id, amount, reason, balance_after)
    SELECT id, 20000, 'monthly_reset', 20000 FROM users;

    INSERT INTO migration_markers (id) VALUES ('credit_rate_update_v1');
  END IF;
END $$;
