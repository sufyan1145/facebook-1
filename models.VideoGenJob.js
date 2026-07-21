const { query } = require('./config.database');

const VideoGenJob = {
  async create(userId, { driveFolderId, driveFolderName, topic, duration, aspectRatio }) {
    const res = await query(
      `INSERT INTO video_gen_jobs (user_id, drive_folder_id, drive_folder_name, topic, duration, aspect_ratio, status)
       VALUES ($1,$2,$3,$4,$5,$6,'pending')
       RETURNING *`,
      [userId, driveFolderId, driveFolderName, topic, duration || '5', aspectRatio || '9:16']
    );
    return res.rows[0];
  },

  async setTaskId(id, kieTaskId) {
    await query(`UPDATE video_gen_jobs SET kie_task_id = $2, status = 'generating', updated_at = now() WHERE id = $1`, [id, kieTaskId]);
  },

  async markCompleted(id, { driveFileId, driveFileName }) {
    await query(
      `UPDATE video_gen_jobs SET status = 'completed', drive_file_id = $2, drive_file_name = $3, updated_at = now() WHERE id = $1`,
      [id, driveFileId, driveFileName]
    );
  },

  async markFailed(id, errorMessage) {
    await query(`UPDATE video_gen_jobs SET status = 'failed', error_message = $2, updated_at = now() WHERE id = $1`, [id, errorMessage]);
  },

  async setStatus(id, status) {
    await query(`UPDATE video_gen_jobs SET status = $2, updated_at = now() WHERE id = $1`, [id, status]);
  },

  async listInProgress() {
    const res = await query(`SELECT * FROM video_gen_jobs WHERE status IN ('generating', 'downloading')`);
    return res.rows;
  },

  async listByUser(userId, limit = 50) {
    const res = await query(`SELECT * FROM video_gen_jobs WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2`, [userId, limit]);
    return res.rows;
  },
};

module.exports = VideoGenJob;
