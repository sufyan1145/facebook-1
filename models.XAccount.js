const { query } = require('./config.database');
const { encrypt, decrypt } = require('./utils.encryption');

const PUBLIC = 'id, username, display_name, x_user_id, status, last_error, last_used_at, connected_at';

const XAccount = {
  // Same X account connected again -> just refresh its cookies.
  async upsert(userId, { username, displayName, xUserId, authToken, ct0 }) {
    const res = await query(
      `INSERT INTO x_accounts (user_id, username, display_name, x_user_id, auth_token, ct0, status, last_error)
       VALUES ($1,$2,$3,$4,$5,$6,'active',NULL)
       ON CONFLICT (user_id, lower(username)) DO UPDATE SET
         display_name = EXCLUDED.display_name, x_user_id = EXCLUDED.x_user_id,
         auth_token = EXCLUDED.auth_token, ct0 = EXCLUDED.ct0,
         status = 'active', last_error = NULL, updated_at = now()
       RETURNING ${PUBLIC}`,
      [userId, username, displayName || null, xUserId || null, encrypt(authToken), encrypt(ct0)]
    );
    return res.rows[0];
  },

  async listByUser(userId) {
    const res = await query(`SELECT ${PUBLIC} FROM x_accounts WHERE user_id = $1 ORDER BY connected_at`, [userId]);
    return res.rows;
  },

  // With decrypted cookies - server-side use only.
  async findById(userId, id) {
    const res = await query('SELECT * FROM x_accounts WHERE user_id = $1 AND id = $2', [userId, id]);
    const row = res.rows[0];
    if (!row) return null;
    return { ...row, auth_token: decrypt(row.auth_token), ct0: decrypt(row.ct0) };
  },

  async markUsed(id) {
    await query(`UPDATE x_accounts SET last_used_at = now(), status = 'active', last_error = NULL WHERE id = $1`, [id]);
  },

  async markExpired(id, message) {
    await query(`UPDATE x_accounts SET status = 'expired', last_error = $2, updated_at = now() WHERE id = $1`, [id, String(message || '').slice(0, 300)]);
  },

  async setCt0(id, ct0) {
    await query('UPDATE x_accounts SET ct0 = $2, updated_at = now() WHERE id = $1', [id, encrypt(ct0)]);
  },

  async remove(userId, id) {
    await query('DELETE FROM x_accounts WHERE user_id = $1 AND id = $2', [userId, id]);
  },
};

module.exports = XAccount;
