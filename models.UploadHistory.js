const { query } = require('./config.database');

const UploadHistory = {
  // Explicit find-then-update-or-insert instead of ON CONFLICT: the UNIQUE
  // constraint is (drive_file_id, facebook_page_id), but Postgres treats every
  // NULL facebook_page_id as distinct from every other NULL - so for
  // YouTube-only schedules (no Facebook page, facebook_page_id = NULL) the
  // ON CONFLICT clause never matched, silently creating a new row - and
  // losing youtube_video_id/facebook_video_id - on every retry.
  async create(userId, data) {
    const existing = await query(
      `SELECT * FROM upload_history WHERE drive_file_id = $1 AND facebook_page_id IS NOT DISTINCT FROM $2`,
      [data.driveFileId, data.facebookPageId || null]
    );
    if (existing.rows[0]) {
      const res = await query(
        `UPDATE upload_history SET status = $2, schedule_id = $3, video_name = $4 WHERE id = $1 RETURNING *`,
        [existing.rows[0].id, data.status || 'pending', data.scheduleId, data.videoName]
      );
      return res.rows[0];
    }
    const res = await query(
      `INSERT INTO upload_history
        (user_id, schedule_id, drive_file_id, video_name, facebook_page_id, drive_folder_name,
         duration_seconds, file_hash, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
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

  async markYoutubeUploaded(id, youtubeVideoId) {
    await query(`UPDATE upload_history SET youtube_video_id = $2 WHERE id = $1`, [id, youtubeVideoId]);
  },

  async markFailed(id) {
    await query(`UPDATE upload_history SET status = 'failed' WHERE id = $1`, [id]);
  },

  async alreadyUploaded(driveFileId, facebookPageId) {
    const res = await query(
      `SELECT * FROM upload_history WHERE drive_file_id = $1 AND facebook_page_id IS NOT DISTINCT FROM $2 AND status = 'success'`,
      [driveFileId, facebookPageId || null]
    );
    return !!res.rows[0];
  },

  async getUploadedFileIds(facebookPageId) {
    const res = await query(
      `SELECT drive_file_id FROM upload_history WHERE facebook_page_id IS NOT DISTINCT FROM $1 AND status = 'success'`,
      [facebookPageId || null]
    );
    return res.rows.map((r) => r.drive_file_id);
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
