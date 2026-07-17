const { query } = require('./config.database');
const { encrypt, decrypt } = require('./utils.encryption');

const FacebookToken = {
  async upsert(userId, { accessToken, expiryTime, fbUserId }) {
    const res = await query(
      `INSERT INTO facebook_tokens (user_id, access_token, expiry_time, fb_user_id)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (user_id) DO UPDATE SET
         access_token = EXCLUDED.access_token,
         expiry_time = EXCLUDED.expiry_time,
         fb_user_id = EXCLUDED.fb_user_id,
         updated_at = now()
       RETURNING *`,
      [userId, encrypt(accessToken), expiryTime, fbUserId]
    );
    return res.rows[0];
  },

  async findByUser(userId) {
    const res = await query('SELECT * FROM facebook_tokens WHERE user_id = $1', [userId]);
    const row = res.rows[0];
    if (!row) return null;
    return { ...row, access_token: decrypt(row.access_token) };
  },

  async remove(userId) {
    await query('DELETE FROM facebook_tokens WHERE user_id = $1', [userId]);
  },
};

module.exports = FacebookToken;
