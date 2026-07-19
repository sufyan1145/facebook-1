const { query } = require('./config.database');

const User = {
  async create({
    name,
    email,
    passwordHash,
    googleId = null,
    isEmailVerified = false,
    emailVerifyToken = null,
    planType = 'trial',
    planExpiresAt = null,
    isAdmin = false,
    createdBy = null,
  }) {
    const res = await query(
      `INSERT INTO users (name, email, password_hash, google_id, is_email_verified, email_verify_token, plan_type, plan_started_at, plan_expires_at, is_admin, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,now(),$8,$9,$10) RETURNING *`,
      [name, email, passwordHash, googleId, isEmailVerified, emailVerifyToken, planType, planExpiresAt, isAdmin, createdBy]
    );
    return res.rows[0];
  },

  async findByEmail(email) {
    const res = await query('SELECT * FROM users WHERE email = $1', [email]);
    return res.rows[0];
  },

  async findById(id) {
    const res = await query('SELECT * FROM users WHERE id = $1', [id]);
    return res.rows[0];
  },

  async findByGoogleId(googleId) {
    const res = await query('SELECT * FROM users WHERE google_id = $1', [googleId]);
    return res.rows[0];
  },

  async setEmailVerified(id) {
    await query('UPDATE users SET is_email_verified = TRUE, email_verify_token = NULL, updated_at = now() WHERE id = $1', [id]);
  },

  async setPasswordResetToken(id, token, expires) {
    await query('UPDATE users SET password_reset_token = $2, password_reset_expires = $3, updated_at = now() WHERE id = $1', [id, token, expires]);
  },

  async findByResetToken(token) {
    const res = await query('SELECT * FROM users WHERE password_reset_token = $1 AND password_reset_expires > now()', [token]);
    return res.rows[0];
  },

  async updatePassword(id, passwordHash) {
    await query('UPDATE users SET password_hash = $2, password_reset_token = NULL, password_reset_expires = NULL, updated_at = now() WHERE id = $1', [id, passwordHash]);
  },

  async updateProfile(id, { name, timezone, language, avatarUrl }) {
    const res = await query(
      `UPDATE users SET name = COALESCE($2,name), timezone = COALESCE($3,timezone),
       language = COALESCE($4,language), avatar_url = COALESCE($5,avatar_url), updated_at = now()
       WHERE id = $1 RETURNING *`,
      [id, name, timezone, language, avatarUrl]
    );
    return res.rows[0];
  },

  async touchLastLogin(id) {
    await query('UPDATE users SET last_login_at = now() WHERE id = $1', [id]);
  },

  // ---------- Admin panel helpers ----------

  async listAll() {
    const res = await query(
      `SELECT id, name, email, is_admin, is_active, plan_type, plan_started_at, plan_expires_at,
              last_login_at, created_at, created_by
       FROM users ORDER BY created_at DESC`
    );
    return res.rows;
  },

  async getStats() {
    const res = await query(`
      SELECT
        COUNT(*) FILTER (WHERE TRUE) AS total_users,
        COUNT(*) FILTER (WHERE plan_type = 'trial') AS trial_users,
        COUNT(*) FILTER (WHERE plan_type = 'paid') AS paid_users,
        COUNT(*) FILTER (WHERE plan_expires_at IS NOT NULL AND plan_expires_at < now()) AS expired_users,
        COUNT(*) FILTER (WHERE plan_expires_at IS NULL OR plan_expires_at >= now()) AS active_users,
        COUNT(*) FILTER (WHERE created_at >= now() - interval '7 days') AS new_last_7_days,
        COUNT(*) FILTER (WHERE last_login_at >= now() - interval '1 days') AS active_last_24h
      FROM users
    `);
    return res.rows[0];
  },

  async setPlan(id, { planType, planExpiresAt }) {
    const res = await query(
      `UPDATE users SET plan_type = $2, plan_started_at = now(), plan_expires_at = $3, updated_at = now()
       WHERE id = $1 RETURNING *`,
      [id, planType, planExpiresAt]
    );
    return res.rows[0];
  },

  async setActive(id, isActive) {
    const res = await query('UPDATE users SET is_active = $2, updated_at = now() WHERE id = $1 RETURNING *', [id, isActive]);
    return res.rows[0];
  },

  async remove(id) {
    await query('DELETE FROM users WHERE id = $1', [id]);
  },
};

module.exports = User;
