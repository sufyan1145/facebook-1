const { query } = require('./config.database');
const { encrypt, decrypt } = require('./utils.encryption');

const GoogleToken = {
  async upsert(userId, { accessToken, refreshToken, expiryTime, scope }) {
    const res = await query(
      `INSERT INTO google_tokens (user_id, access_token, refresh_token, expiry_time, scope)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (user_id) DO UPDATE SET
         access_token = EXCLUDED.access_token,
         refresh_token = COALESCE(EXCLUDED.refresh_token, google_tokens.refresh_token),
         expiry_time = EXCLUDED.expiry_time,
         scope = EXCLUDED.scope,
         updated_at = now()
       RETURNING *`,
      [userId, encrypt(accessToken), refreshToken ? encrypt(refreshToken) : null, expiryTime, scope]
    );
    return res.rows[0];
  },

  async findByUser(userId) {
    const res = await query('SELECT * FROM google_tokens WHERE user_id = $1', [userId]);
    const row = res.rows[0];
    if (!row) return null;
    return {
      ...row,
      access_token: decrypt(row.access_token),
      refresh_token: row.refresh_token ? decrypt(row.refresh_token) : null,
    };
  },

  async remove(userId) {
    await query('DELETE FROM google_tokens WHERE user_id = $1', [userId]);
  },
};

module.exports = GoogleToken;
