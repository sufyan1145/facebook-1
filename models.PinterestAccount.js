const { query } = require('./config.database');
const { encrypt, decrypt } = require('./utils.encryption');

const PUBLIC = 'id, username, board_id, board_name, status, last_error, last_used_at, connected_at, expires_at, refresh_expires_at';

const PinterestAccount = {
  // Same Pinterest account connected again -> refresh its tokens (the chosen board is kept).
  async upsert(userId, { username, accessToken, refreshToken, expiresAt, refreshExpiresAt }) {
    const res = await query(
      `INSERT INTO pinterest_accounts (user_id, username, access_token, refresh_token, expires_at, refresh_expires_at, status, last_error)
       VALUES ($1,$2,$3,$4,$5,$6,'active',NULL)
       ON CONFLICT (user_id, lower(username)) DO UPDATE SET
         access_token = EXCLUDED.access_token, refresh_token = EXCLUDED.refresh_token,
         expires_at = EXCLUDED.expires_at, refresh_expires_at = EXCLUDED.refresh_expires_at,
         status = 'active', last_error = NULL, updated_at = now()
       RETURNING ${PUBLIC}`,
      [userId, username, encrypt(accessToken), refreshToken ? encrypt(refreshToken) : null, expiresAt || null, refreshExpiresAt || null]
    );
    return res.rows[0];
  },

  async listByUser(userId) {
    const res = await query(`SELECT ${PUBLIC} FROM pinterest_accounts WHERE user_id = $1 ORDER BY connected_at`, [userId]);
    return res.rows;
  },

  // With decrypted tokens - server-side use only.
  async findById(userId, id) {
    const res = await query('SELECT * FROM pinterest_accounts WHERE user_id = $1 AND id = $2', [userId, id]);
    const row = res.rows[0];
    if (!row) return null;
    return { ...row, access_token: decrypt(row.access_token), refresh_token: decrypt(row.refresh_token) };
  },

  async setTokens(id, { accessToken, refreshToken, expiresAt, refreshExpiresAt }) {
    await query(
      `UPDATE pinterest_accounts SET access_token = $2, refresh_token = COALESCE($3, refresh_token), expires_at = $4,
         refresh_expires_at = COALESCE($5, refresh_expires_at), status = 'active', last_error = NULL, updated_at = now() WHERE id = $1`,
      [id, encrypt(accessToken), refreshToken ? encrypt(refreshToken) : null, expiresAt || null, refreshExpiresAt || null]
    );
  },

  async setBoard(userId, id, boardId, boardName) {
    const res = await query(
      `UPDATE pinterest_accounts SET board_id = $3, board_name = $4, updated_at = now() WHERE user_id = $1 AND id = $2 RETURNING ${PUBLIC}`,
      [userId, id, boardId, boardName]
    );
    return res.rows[0];
  },

  async markUsed(id) {
    await query(`UPDATE pinterest_accounts SET last_used_at = now(), status = 'active', last_error = NULL WHERE id = $1`, [id]);
  },

  async markExpired(id, message) {
    await query(`UPDATE pinterest_accounts SET status = 'expired', last_error = $2, updated_at = now() WHERE id = $1`, [id, String(message || '').slice(0, 300)]);
  },

  async remove(userId, id) {
    await query('DELETE FROM pinterest_accounts WHERE user_id = $1 AND id = $2', [userId, id]);
  },
};

module.exports = PinterestAccount;
