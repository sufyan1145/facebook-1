-- Rate/quota update: 20,000 credits/month (was 45,000). Pipeline videos are
-- 2 credits/sec (10s = 20 credits); Video Generator (Vertex Veo3, real
-- per-second Google billing) is 18.75 credits/sec (8s = 150 credits) - set in
-- utils.credits.js, not the database, but the monthly total and existing
-- balances need updating here.
ALTER TABLE users ALTER COLUMN credits_remaining SET DEFAULT 20000;

-- Reset everyone to the new monthly amount now, so no one is left holding a
-- balance computed under the old 45,000/1.5-per-sec rate structure.
UPDATE users SET credits_remaining = 20000, credits_reset_at = now() + interval '30 days';

INSERT INTO credit_transactions (user_id, amount, reason, balance_after)
SELECT id, 20000, 'monthly_reset', 20000 FROM users;
