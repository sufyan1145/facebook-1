const { query } = require('./config.database');

const User = {
  async create({ name, email, passwordHash, googleId = null, isEmailVerified = false, emailVerifyToken = null }) {
    const res = await query(
      `INSERT INTO users (name, email, password_hash, google_id, is_email_verified, email_verify_token)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [name, email, passwordHash, googleId, isEmailVerified, emailVerifyToken]
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
};

module.exports = User;
