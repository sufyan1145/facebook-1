const { query } = require('./config.database');
const { encrypt, decrypt } = require('./utils.encryption');

const PUBLIC = 'id, username, threads_user_id, status, last_error, last_used_at, connected_at, expires_at';

const ThreadsAccount = {
  // Same Threads account connected again -> refresh its token.
  async upsert(userId, { username, threadsUserId, accessToken, expiresAt }) {
    const res = await query(
      `INSERT INTO threads_accounts (user_id, username, threads_user_id, access_token, expires_at, status, last_error)
       VALUES ($1,$2,$3,$4,$5,'active',NULL)
       ON CONFLICT (user_id, lower(username)) DO UPDATE SET
         threads_user_id = EXCLUDED.threads_user_id, access_token = EXCLUDED.access_token, expires_at = EXCLUDED.expires_at,
         status = 'active', last_error = NULL, updated_at = now()
       RETURNING ${PUBLIC}`,
      [userId, username, String(threadsUserId), encrypt(accessToken), expiresAt || null]
    );
    return res.rows[0];
  },

  async listByUser(userId) {
    const res = await query(`SELECT ${PUBLIC} FROM threads_accounts WHERE user_id = $1 ORDER BY connected_at`, [userId]);
    return res.rows;
  },

  // With the decrypted token - server-side use only.
  async findById(userId, id) {
    const res = await query('SELECT * FROM threads_accounts WHERE user_id = $1 AND id = $2', [userId, id]);
    const row = res.rows[0];
    if (!row) return null;
    return { ...row, access_token: decrypt(row.access_token) };
  },

  async setToken(id, accessToken, expiresAt) {
    await query(`UPDATE threads_accounts SET access_token = $2, expires_at = $3, status = 'active', last_error = NULL, updated_at = now() WHERE id = $1`,
      [id, encrypt(accessToken), expiresAt || null]);
  },

  async markUsed(id) {
    await query(`UPDATE threads_accounts SET last_used_at = now(), status = 'active', last_error = NULL WHERE id = $1`, [id]);
  },

  async markExpired(id, message) {
    await query(`UPDATE threads_accounts SET status = 'expired', last_error = $2, updated_at = now() WHERE id = $1`, [id, String(message || '').slice(0, 300)]);
  },

  async remove(userId, id) {
    await query('DELETE FROM threads_accounts WHERE user_id = $1 AND id = $2', [userId, id]);
  },
};

module.exports = ThreadsAccount;
