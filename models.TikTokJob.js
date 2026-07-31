const { query } = require('./config.database');

const TikTokJob = {
  async create(userId, { sourceUrl, driveFolderId, driveFolderName }) {
    const res = await query(
      `INSERT INTO tiktok_download_jobs (user_id, source_url, drive_folder_id, drive_folder_name, status)
       VALUES ($1,$2,$3,$4,'pending')
       RETURNING *`,
      [userId, sourceUrl, driveFolderId || null, driveFolderName || null]
    );
    return res.rows[0];
  },

  async setStatus(id, status) {
    await query('UPDATE tiktok_download_jobs SET status = $2, updated_at = now() WHERE id = $1', [id, status]);
  },

  async setOriginalMetadata(id, { originalTitle, originalDescription }) {
    await query(
      'UPDATE tiktok_download_jobs SET original_title = $2, original_description = $3, updated_at = now() WHERE id = $1',
      [id, originalTitle, originalDescription]
    );
  },

  async markCompleted(id, { driveFileId = null, driveFileName = null, localFilePath = null, generatedTitle, generatedHashtags }) {
    await query(
      `UPDATE tiktok_download_jobs
       SET status = 'completed', drive_file_id = $2, drive_file_name = $3, local_file_path = $4,
           generated_title = $5, generated_hashtags = $6, updated_at = now()
       WHERE id = $1`,
      [id, driveFileId, driveFileName, localFilePath, generatedTitle, generatedHashtags]
    );
  },

  async markFailed(id, errorMessage) {
    await query(
      `UPDATE tiktok_download_jobs SET status = 'failed', error_message = $2, updated_at = now() WHERE id = $1`,
      [id, errorMessage]
    );
  },

  async listByUser(userId, limit = 50) {
    const res = await query(
      'SELECT * FROM tiktok_download_jobs WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2',
      [userId, limit]
    );
    return res.rows;
  },

  async findById(userId, id) {
    const res = await query('SELECT * FROM tiktok_download_jobs WHERE id = $1 AND user_id = $2', [id, userId]);
    return res.rows[0];
  },
};

module.exports = TikTokJob;
