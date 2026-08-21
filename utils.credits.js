const { query } = require('./config.database');
const logger = require('./utils.logger');

// Two different rates depending on what's generating the video:
// - Content Pipeline (Nano Banana images + TTS): cheap, so a generous rate.
//   10s = 20 credits (2 credits/sec).
// - Video Generator (Vertex Veo3, real per-second Google billing): priced to
//   track the actual Vertex cost. 8s = 150 credits (18.75 credits/sec).
const MONTHLY_CREDITS = 20000;
const RATE_BY_REASON = {
  pipeline_video: 2,
  video_generator: 18.75,
  text_image_post_ai: 40, // flat cost for one AI-generated image (charged as costForSeconds(1, ...))
};
const DEFAULT_RATE = 2;

function rateFor(reason) {
  return RATE_BY_REASON[reason] || DEFAULT_RATE;
}

function costForSeconds(seconds, reason = 'pipeline_video') {
  return Math.max(1, Math.round(seconds * rateFor(reason)));
}

class InsufficientCreditsError extends Error {
  constructor(required, available) {
    super(`Not enough credits: this needs ${required}, you have ${available} remaining this month.`);
    this.code = 'INSUFFICIENT_CREDITS';
    this.required = required;
    this.available = available;
  }
}

// If the user's monthly window has elapsed, reset their balance back to the
// full monthly allowance and push the reset date forward another 30 days.
async function ensureMonthlyReset(userId) {
  const res = await query('SELECT credits_remaining, credits_reset_at FROM users WHERE id = $1', [userId]);
  const user = res.rows[0];
  if (!user) throw new Error('User not found');

  if (new Date(user.credits_reset_at) <= new Date()) {
    const updated = await query(
      `UPDATE users SET credits_remaining = $2, credits_reset_at = now() + interval '30 days', updated_at = now()
       WHERE id = $1 RETURNING credits_remaining, credits_reset_at`,
      [userId, MONTHLY_CREDITS]
    );
    await query(
      `INSERT INTO credit_transactions (user_id, amount, reason, balance_after) VALUES ($1, $2, 'monthly_reset', $3)`,
      [userId, MONTHLY_CREDITS, MONTHLY_CREDITS]
    );
    logger.info(`[credits] monthly reset for user ${userId} -> ${MONTHLY_CREDITS}`);
    return updated.rows[0];
  }
  return user;
}

async function getBalance(userId) {
  const user = await ensureMonthlyReset(userId);
  return { creditsRemaining: user.credits_remaining, creditsResetAt: user.credits_reset_at, monthlyCredits: MONTHLY_CREDITS };
}

// Deducts credits upfront for `seconds` of video. Throws InsufficientCreditsError
// (without charging anything) if the balance can't cover it. Returns the charge
// amount and new balance so the caller can refund/adjust later if the actual
// video ends up a different length than originally estimated.
async function charge(userId, seconds, reason, referenceId = null) {
  const user = await ensureMonthlyReset(userId);
  const amount = costForSeconds(seconds, reason);
  if (user.credits_remaining < amount) {
    throw new InsufficientCreditsError(amount, user.credits_remaining);
  }
  const res = await query(
    `UPDATE users SET credits_remaining = credits_remaining - $2, updated_at = now() WHERE id = $1 RETURNING credits_remaining`,
    [userId, amount]
  );
  const balanceAfter = res.rows[0].credits_remaining;
  await query(
    `INSERT INTO credit_transactions (user_id, amount, reason, seconds, reference_id, balance_after) VALUES ($1, $2, $3, $4, $5, $6)`,
    [userId, -amount, reason, seconds, referenceId, balanceAfter]
  );
  return { amount, balanceAfter };
}

// Adjusts a previously-charged amount to match the actual final video length
// (e.g. voiceover ran longer/shorter than the estimate). Positive delta = extra
// charge, negative delta = refund. Never throws for insufficient credits here -
// the work is already done, so we let the balance go negative rather than fail
// after the fact; ensureMonthlyReset will bring it back to a fresh allowance
// next cycle regardless.
async function reconcile(userId, previouslyChargedSeconds, actualSeconds, reason, referenceId = null) {
  const originalAmount = costForSeconds(previouslyChargedSeconds, reason);
  const actualAmount = costForSeconds(actualSeconds, reason);
  const delta = actualAmount - originalAmount;
  if (delta === 0) return { amount: 0, balanceAfter: null };

  const res = await query(
    `UPDATE users SET credits_remaining = credits_remaining - $2, updated_at = now() WHERE id = $1 RETURNING credits_remaining`,
    [userId, delta]
  );
  const balanceAfter = res.rows[0].credits_remaining;
  await query(
    `INSERT INTO credit_transactions (user_id, amount, reason, seconds, reference_id, balance_after) VALUES ($1, $2, $3, $4, $5, $6)`,
    [userId, -delta, delta > 0 ? reason : 'refund', actualSeconds - previouslyChargedSeconds, referenceId, balanceAfter]
  );
  return { amount: delta, balanceAfter };
}

// Full refund of a previous charge (e.g. the generation failed entirely).
async function refund(userId, seconds, referenceId = null, reason = 'pipeline_video') {
  const amount = costForSeconds(seconds, reason);
  const res = await query(
    `UPDATE users SET credits_remaining = credits_remaining + $2, updated_at = now() WHERE id = $1 RETURNING credits_remaining`,
    [userId, amount]
  );
  const balanceAfter = res.rows[0].credits_remaining;
  await query(
    `INSERT INTO credit_transactions (user_id, amount, reason, seconds, reference_id, balance_after) VALUES ($1, $2, 'refund', $3, $4, $5)`,
    [userId, amount, seconds, referenceId, balanceAfter]
  );
  return { amount, balanceAfter };
}

module.exports = {
  MONTHLY_CREDITS,
  RATE_BY_REASON,
  costForSeconds,
  InsufficientCreditsError,
  ensureMonthlyReset,
  getBalance,
  charge,
  reconcile,
  refund,
};
