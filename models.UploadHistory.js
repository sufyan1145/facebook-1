const { query } = require('./config.database');

const UploadHistory = {
  async create(userId, data) {
    const res = await query(
      `INSERT INTO upload_history
        (user_id, schedule_id, drive_file_id, video_name, facebook_page_id, drive_folder_name,
         duration_seconds, file_hash, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (drive_file_id, facebook_page_id) DO NOTHING
       RETURNING *`,
      [
        userId, data.scheduleId, data.driveFileId, data.videoName, data.facebookPageId,
        data.driveFolderName, data.durationSeconds, data.fileHash, data.status || 'pending',
      ]
    );
    return res.rows[0];
  },

  async markSuccess(id, facebookVideoId) {
    await query(
      `UPDATE upload_history SET status = 'success', facebook_video_id = $2, uploaded_at = now() WHERE id = $1`,
      [id, facebookVideoId]
    );
  },

  async markFailed(id) {
    await query(`UPDATE upload_history SET status = 'failed' WHERE id = $1`, [id]);
  },

  async alreadyUploaded(driveFileId, facebookPageId) {
    const res = await query(
      `SELECT * FROM upload_history WHERE drive_file_id = $1 AND facebook_page_id = $2 AND status = 'success'`,
      [driveFileId, facebookPageId]
    );
    return !!res.rows[0];
  },

  async listByUser(userId, { limit = 50, offset = 0 } = {}) {
    const res = await query(
      'SELECT * FROM upload_history WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2 OFFSET $3',
      [userId, limit, offset]
    );
    return res.rows;
  },

  async statsByUser(userId) {
    const res = await query(
      `SELECT
         COUNT(*) FILTER (WHERE status = 'success' AND uploaded_at::date = CURRENT_DATE) AS today_uploads,
         COUNT(*) FILTER (WHERE status = 'failed') AS failed_uploads,
         COUNT(*) FILTER (WHERE status = 'success') AS total_uploads
       FROM upload_history WHERE user_id = $1`,
      [userId]
    );
    return res.rows[0];
  },
};

module.exports = UploadHistory;
