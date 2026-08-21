const { query } = require('./config.database');

const TextImagePost = {
  async create(userId, data) {
    const res = await query(
      `INSERT INTO text_image_posts (user_id, page_id, message, image_source, drive_file_id, drive_file_name, ai_prompt, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'queued')
       RETURNING *`,
      [
        userId,
        data.pageId,
        data.message || null,
        data.imageSource,
        data.driveFileId || null,
        data.driveFileName || null,
        data.aiPrompt || null,
      ]
    );
    return res.rows[0];
  },

  async findById(id) {
    const res = await query('SELECT * FROM text_image_posts WHERE id = $1', [id]);
    return res.rows[0];
  },

  async markProcessing(id) {
    await query(`UPDATE text_image_posts SET status = 'processing', updated_at = now() WHERE id = $1`, [id]);
  },

  async markSuccess(id, facebookPostId) {
    await query(
      `UPDATE text_image_posts SET status = 'success', facebook_post_id = $2, updated_at = now() WHERE id = $1`,
      [id, facebookPostId]
    );
  },

  async markFailed(id, errorMessage) {
    await query(
      `UPDATE text_image_posts SET status = 'failed', error_message = $2, updated_at = now() WHERE id = $1`,
      [id, errorMessage]
    );
  },

  async listByUser(userId, { limit = 50, offset = 0 } = {}) {
    const res = await query(
      `SELECT t.*, p.page_name
       FROM text_image_posts t
       LEFT JOIN pages p ON p.id = t.page_id
       WHERE t.user_id = $1
       ORDER BY t.created_at DESC
       LIMIT $2 OFFSET $3`,
      [userId, limit, offset]
    );
    return res.rows;
  },

  // Drive file ids already successfully posted to this specific page - used both to
  // hide them from the picker and to block a duplicate repost of the same image on
  // the same page (a different page is unaffected, so the same image can still be
  // used there).
  async getPostedFileIds(pageId) {
    const res = await query(
      `SELECT DISTINCT drive_file_id FROM text_image_posts
       WHERE page_id = $1 AND status = 'success' AND drive_file_id IS NOT NULL`,
      [pageId]
    );
    return res.rows.map((r) => r.drive_file_id);
  },

  async wasAlreadyPostedToPage(pageId, driveFileId) {
    const res = await query(
      `SELECT 1 FROM text_image_posts
       WHERE page_id = $1 AND drive_file_id = $2 AND status = 'success' LIMIT 1`,
      [pageId, driveFileId]
    );
    return res.rows.length > 0;
  },
};

module.exports = TextImagePost;
