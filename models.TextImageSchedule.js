const { query } = require('./config.database');

const TextImageSchedule = {
  async create(userId, data) {
    const res = await query(
      `INSERT INTO text_image_schedules
        (user_id, page_id, message, image_source, folder_id, ai_prompt, upload_time, timezone,
         repeat_type, specific_days, interval_hours, times)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       RETURNING *`,
      [
        userId, data.pageId, data.message || null, data.imageSource,
        data.imageSource === 'drive' ? data.folderId : null,
        data.imageSource === 'ai' ? data.aiPrompt : null,
        data.uploadTime, data.timezone, data.repeat,
        data.specificDays || null, data.intervalHours || null,
        data.times && data.times.length ? JSON.stringify(data.times) : null,
      ]
    );
    return res.rows[0];
  },

  async listByUser(userId) {
    const res = await query(
      `SELECT s.*, p.page_name, df.folder_name
       FROM text_image_schedules s
       LEFT JOIN pages p ON p.id = s.page_id
       LEFT JOIN drive_folders df ON df.id = s.folder_id
       WHERE s.user_id = $1 ORDER BY s.created_at DESC`,
      [userId]
    );
    return res.rows;
  },

  async setActive(userId, id, isActive) {
    const res = await query(
      'UPDATE text_image_schedules SET is_active = $3, updated_at = now() WHERE user_id = $1 AND id = $2 RETURNING *',
      [userId, id, isActive]
    );
    return res.rows[0];
  },

  async remove(userId, id) {
    await query('DELETE FROM text_image_schedules WHERE user_id = $1 AND id = $2', [userId, id]);
  },

  async findById(userId, id) {
    const res = await query('SELECT * FROM text_image_schedules WHERE user_id = $1 AND id = $2', [userId, id]);
    return res.rows[0];
  },

  // Same atomic per-slot claim strategy proven in models.Schedule.js: only the
  // caller that flips last_run_slots[slotKey] to today's date gets to fire -
  // safe against overlapping ticks or multiple worker replicas.
  async claimSlot(id, slotKey, dateKey) {
    const res = await query(
      `UPDATE text_image_schedules
       SET last_run_slots = jsonb_set(COALESCE(last_run_slots, '{}'::jsonb), ARRAY[$2::text], to_jsonb($3::text), true),
           last_run_at = now()
       WHERE id = $1
         AND COALESCE(last_run_slots ->> $2, '') IS DISTINCT FROM $3
       RETURNING id`,
      [id, slotKey, dateKey]
    );
    return res.rows.length > 0;
  },

  async claimInterval(id, intervalSeconds) {
    const res = await query(
      `UPDATE text_image_schedules
       SET last_run_at = now()
       WHERE id = $1
         AND (last_run_at IS NULL OR now() - last_run_at >= ($2 || ' seconds')::interval)
       RETURNING id`,
      [id, intervalSeconds]
    );
    return res.rows.length > 0;
  },
};

module.exports = TextImageSchedule;
