const { query } = require('./config.database');

const ContentScheduleRun = {
  async create(userId, contentScheduleId) {
    const res = await query(
      `INSERT INTO content_schedule_runs (user_id, content_schedule_id, status) VALUES ($1,$2,'pending') RETURNING *`,
      [userId, contentScheduleId]
    );
    return res.rows[0];
  },

  async setStatus(id, status, extra = {}) {
    await query(
      `UPDATE content_schedule_runs SET status = $2, topic = COALESCE($3, topic), updated_at = now() WHERE id = $1`,
      [id, status, extra.topic || null]
    );
  },

  async markCompleted(id, { driveFileId, fbVideoId }) {
    await query(
      `UPDATE content_schedule_runs SET status = 'completed', drive_file_id = $2, fb_video_id = $3, updated_at = now() WHERE id = $1`,
      [id, driveFileId, fbVideoId]
    );
  },

  async markFailed(id, errorMessage) {
    await query(
      `UPDATE content_schedule_runs SET status = 'failed', error_message = $2, updated_at = now() WHERE id = $1`,
      [id, errorMessage]
    );
  },

  async listByUser(userId, limit = 50) {
    const res = await query(
      `SELECT r.*, cs.keyword FROM content_schedule_runs r
       JOIN content_schedules cs ON cs.id = r.content_schedule_id
       WHERE r.user_id = $1 ORDER BY r.created_at DESC LIMIT $2`,
      [userId, limit]
    );
    return res.rows;
  },
};

module.exports = ContentScheduleRun;
