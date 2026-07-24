const { query } = require('./config.database');

const Schedule = {
  async create(userId, data) {
    const res = await query(
      `INSERT INTO schedules
        (user_id, page_id, folder_id, upload_time, timezone, repeat_type, specific_days,
         max_uploads, random_delay_seconds, caption, hashtags, privacy, publish_immediately, interval_hours, times,
         post_to_facebook, youtube_token_id, youtube_video_type)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
       RETURNING *`,
      [
        userId, data.pageId || null, data.folderId, data.uploadTime, data.timezone, data.repeat,
        data.specificDays || null, data.maxUploads || 1, data.randomDelaySeconds || 0,
        data.caption || null, data.hashtags || null, data.privacy || 'PUBLISHED',
        data.publishImmediately !== false, data.intervalHours || null,
        data.times && data.times.length ? JSON.stringify(data.times) : null,
        data.postToFacebook !== false, data.youtubeTokenId || null, data.youtubeVideoType || 'auto',
      ]
    );
    return res.rows[0];
  },

  async listByUser(userId) {
    const res = await query(
      `SELECT s.*, p.page_name, df.folder_name
       FROM schedules s
       LEFT JOIN pages p ON p.id = s.page_id
       JOIN drive_folders df ON df.id = s.folder_id
       WHERE s.user_id = $1 ORDER BY s.created_at DESC`,
      [userId]
    );
    return res.rows;
  },

  async findDue(nowHHMM) {
    // returns active schedules whose upload_time matches current minute (per their timezone, handled by caller)
    const res = await query(`SELECT * FROM schedules WHERE is_active = TRUE`);
    return res.rows;
  },

  async setActive(userId, id, isActive) {
    const res = await query(
      'UPDATE schedules SET is_active = $3, updated_at = now() WHERE user_id = $1 AND id = $2 RETURNING *',
      [userId, id, isActive]
    );
    return res.rows[0];
  },

  async updateLastRun(id) {
    await query('UPDATE schedules SET last_run_at = now() WHERE id = $1', [id]);
  },

  async remove(userId, id) {
    await query('DELETE FROM schedules WHERE user_id = $1 AND id = $2', [userId, id]);
  },

  async findById(userId, id) {
    const res = await query('SELECT * FROM schedules WHERE user_id = $1 AND id = $2', [userId, id]);
    return res.rows[0];
  },
};

module.exports = Schedule;
