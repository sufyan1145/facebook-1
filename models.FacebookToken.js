const { query } = require('./config.database');
const { encrypt, decrypt } = require('./utils.encryption');

const FacebookToken = {
  // Adds a new Facebook account for this user, or updates it if it's already connected
  async upsert(userId, { accessToken, expiryTime, fbUserId, fbUserName }) {
    const res = await query(
      `INSERT INTO facebook_tokens (user_id, access_token, expiry_time, fb_user_id, fb_user_name)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (user_id, fb_user_id) DO UPDATE SET
         access_token = EXCLUDED.access_token,
         expiry_time = EXCLUDED.expiry_time,
         fb_user_name = EXCLUDED.fb_user_name,
         updated_at = now()
       RETURNING *`,
      [userId, encrypt(accessToken), expiryTime, fbUserId, fbUserName || null]
    );
    return res.rows[0];
  },

  // All Facebook accounts connected by this user (for the account dropdown)
  async listByUser(userId) {
    const res = await query(
      'SELECT id, fb_user_id, fb_user_name, connected_at, expiry_time FROM facebook_tokens WHERE user_id = $1 ORDER BY connected_at',
      [userId]
    );
    return res.rows;
  },

  // A specific connected account, with its decrypted token (used for API calls)
  async findById(userId, id) {
    const res = await query('SELECT * FROM facebook_tokens WHERE user_id = $1 AND id = $2', [userId, id]);
    const row = res.rows[0];
    if (!row) return null;
    return { ...row, access_token: decrypt(row.access_token) };
  },

  // Disconnecting must NEVER delete the Pages: schedules, folder mappings, pipelines and the whole
  // upload history are tied to the Page row, so deleting it (the FK used to cascade) made every
  // already-uploaded video look new again. The Pages are just detached and marked disconnected;
  // connecting the same Facebook account again re-links the very same Page rows.
  async remove(userId, id) {
    await query(
      'UPDATE pages SET facebook_token_id = NULL, is_connected = FALSE, updated_at = now() WHERE user_id = $1 AND facebook_token_id = $2',
      [userId, id]
    );
    await query('DELETE FROM facebook_tokens WHERE user_id = $1 AND id = $2', [userId, id]);
  },
};

module.exports = FacebookToken;
