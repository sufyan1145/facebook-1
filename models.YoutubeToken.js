const { query } = require('./config.database');
const { encrypt, decrypt } = require('./utils.encryption');

const YoutubeToken = {
  // Adds a new YouTube-connected Google account for this user, or updates it if already connected
  async upsert(userId, { accessToken, refreshToken, expiryTime, scope, googleUserId, googleUserEmail, channelTitle }) {
    const res = await query(
      `INSERT INTO youtube_tokens (user_id, google_user_id, google_user_email, channel_title, access_token, refresh_token, expiry_time, scope)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (user_id, google_user_id) DO UPDATE SET
         access_token = EXCLUDED.access_token,
         refresh_token = COALESCE(EXCLUDED.refresh_token, youtube_tokens.refresh_token),
         expiry_time = EXCLUDED.expiry_time,
         scope = EXCLUDED.scope,
         channel_title = COALESCE(EXCLUDED.channel_title, youtube_tokens.channel_title),
         google_user_email = COALESCE(EXCLUDED.google_user_email, youtube_tokens.google_user_email),
         updated_at = now()
       RETURNING *`,
      [userId, googleUserId, googleUserEmail || null, channelTitle || null, encrypt(accessToken), refreshToken ? encrypt(refreshToken) : null, expiryTime, scope]
    );
    return res.rows[0];
  },

  // All YouTube-connected accounts for this user (for the account list + schedule dropdown)
  async listByUser(userId) {
    const res = await query(
      'SELECT id, google_user_id, google_user_email, channel_title, connected_at, expiry_time FROM youtube_tokens WHERE user_id = $1 ORDER BY connected_at',
      [userId]
    );
    return res.rows;
  },

  // A specific connected account, with its decrypted tokens (used for API calls)
  async findById(userId, id) {
    const res = await query('SELECT * FROM youtube_tokens WHERE user_id = $1 AND id = $2', [userId, id]);
    const row = res.rows[0];
    if (!row) return null;
    return {
      ...row,
      access_token: decrypt(row.access_token),
      refresh_token: row.refresh_token ? decrypt(row.refresh_token) : null,
    };
  },

  async remove(userId, id) {
    await query('DELETE FROM youtube_tokens WHERE user_id = $1 AND id = $2', [userId, id]);
  },
};

module.exports = YoutubeToken;
