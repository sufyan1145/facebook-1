const { query } = require('./config.database');

const ContentSchedule = {
  async create(userId, data) {
    const res = await query(
      `INSERT INTO content_schedules
        (user_id, page_id, folder_id, keyword, target_duration_seconds, voice_name,
         upload_time, timezone, repeat_type, specific_days, interval_hours, times,
         caption, hashtags, publish_immediately)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
       RETURNING *`,
      [
        userId, data.pageId, data.folderId, data.keyword, data.targetDurationSeconds || 60,
        data.voiceName || 'Kore', data.uploadTime, data.timezone, data.repeat,
        data.specificDays || null, data.intervalHours || null,
        data.times && data.times.length ? JSON.stringify(data.times) : null,
        data.caption || null, data.hashtags || null, data.publishImmediately !== false,
      ]
    );
    return res.rows[0];
  },

  async listByUser(userId) {
    const res = await query(
      `SELECT cs.*, p.page_name, df.folder_name
       FROM content_schedules cs
       JOIN pages p ON p.id = cs.page_id
       JOIN drive_folders df ON df.id = cs.folder_id
       WHERE cs.user_id = $1 ORDER BY cs.created_at DESC`,
      [userId]
    );
    return res.rows;
  },

  async listActiveDue() {
    const res = await query(
      `SELECT cs.*, p.id as page_db_id, p.page_id as fb_page_id, p.page_name,
              df.folder_id as drive_folder_id, df.folder_name
       FROM content_schedules cs
       JOIN pages p ON p.id = cs.page_id
       JOIN drive_folders df ON df.id = cs.folder_id
       WHERE cs.is_active = TRUE AND p.is_connected = TRUE`
    );
    return res.rows;
  },

  async setActive(userId, id, isActive) {
    const res = await query(
      'UPDATE content_schedules SET is_active = $3, updated_at = now() WHERE user_id = $1 AND id = $2 RETURNING *',
      [userId, id, isActive]
    );
    return res.rows[0];
  },

  async updateLastRun(id) {
    await query('UPDATE content_schedules SET last_run_at = now() WHERE id = $1', [id]);
  },

  async remove(userId, id) {
    await query('DELETE FROM content_schedules WHERE user_id = $1 AND id = $2', [userId, id]);
  },
};

module.exports = ContentSchedule;
