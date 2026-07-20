const { query } = require('./config.database');
const { encrypt, decrypt } = require('./utils.encryption');

const Page = {
  async upsertMany(userId, facebookTokenId, pages) {
    const results = [];
    for (const p of pages) {
      const res = await query(
        `INSERT INTO pages (user_id, facebook_token_id, page_id, page_name, followers, page_access_token, is_connected)
         VALUES ($1,$2,$3,$4,$5,$6,TRUE)
         ON CONFLICT (user_id, page_id) DO UPDATE SET
           facebook_token_id = EXCLUDED.facebook_token_id,
           page_name = EXCLUDED.page_name,
           followers = EXCLUDED.followers,
           page_access_token = EXCLUDED.page_access_token,
           is_connected = TRUE,
           updated_at = now()
         RETURNING *`,
        [userId, facebookTokenId, p.id, p.name, p.followers || 0, encrypt(p.access_token)]
      );
      results.push(res.rows[0]);
    }
    return results;
  },

  // Includes which Facebook account each page belongs to, so the UI can group/label them
  async listByUser(userId) {
    const res = await query(
      `SELECT pg.*, ft.fb_user_name, ft.fb_user_id
       FROM pages pg
       LEFT JOIN facebook_tokens ft ON ft.id = pg.facebook_token_id
       WHERE pg.user_id = $1
       ORDER BY ft.fb_user_name NULLS LAST, pg.page_name`,
      [userId]
    );
    return res.rows.map((r) => ({ ...r, page_access_token: undefined }));
  },

  async findById(userId, id) {
    const res = await query('SELECT * FROM pages WHERE user_id = $1 AND id = $2', [userId, id]);
    const row = res.rows[0];
    if (!row) return null;
    return { ...row, page_access_token: decrypt(row.page_access_token) };
  },

  async disconnect(userId, id) {
    await query('UPDATE pages SET is_connected = FALSE, updated_at = now() WHERE user_id = $1 AND id = $2', [userId, id]);
  },
};

module.exports = Page;
