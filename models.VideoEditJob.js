const { query } = require('./config.database');

const VideoEditJob = {
  async create(userId, { sourceUrl, secondaryUrl, effects, driveFolderId, driveFolderName }) {
    const res = await query(
      `INSERT INTO video_edit_jobs (user_id, source_url, secondary_url, effects_json, drive_folder_id, drive_folder_name, status)
       VALUES ($1,$2,$3,$4,$5,$6,'pending')
       RETURNING *`,
      [userId, sourceUrl, secondaryUrl || null, JSON.stringify(effects || {}), driveFolderId || null, driveFolderName || null]
    );
    return res.rows[0];
  },

  async setStatus(id, status) {
    await query('UPDATE video_edit_jobs SET status = $2, updated_at = now() WHERE id = $1', [id, status]);
  },

  async markCompleted(id, { driveFileId = null, driveFileName = null, localFilePath = null }) {
    await query(
      `UPDATE video_edit_jobs SET status = 'completed', drive_file_id = $2, drive_file_name = $3, local_file_path = $4, updated_at = now() WHERE id = $1`,
      [id, driveFileId, driveFileName, localFilePath]
    );
  },

  async markFailed(id, errorMessage) {
    await query(`UPDATE video_edit_jobs SET status = 'failed', error_message = $2, updated_at = now() WHERE id = $1`, [id, errorMessage]);
  },

  async listByUser(userId, limit = 50) {
    const res = await query('SELECT * FROM video_edit_jobs WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2', [userId, limit]);
    return res.rows;
  },

  async findById(userId, id) {
    const res = await query('SELECT * FROM video_edit_jobs WHERE id = $1 AND user_id = $2', [id, userId]);
    return res.rows[0];
  },

  async deleteById(userId, id) {
    const res = await query('DELETE FROM video_edit_jobs WHERE id = $1 AND user_id = $2 RETURNING *', [id, userId]);
    return res.rows[0];
  },

  async deleteAllForUser(userId) {
    await query('DELETE FROM video_edit_jobs WHERE user_id = $1', [userId]);
  },
};

module.exports = VideoEditJob;
