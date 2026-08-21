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

  /**
   * Atomically claims a time-of-day "slot" (e.g. "18:00" for a multiple_times entry,
   * or "daily"/"weekly"/"monthly"/"specific_days" for the single-time repeat modes)
   * for a given calendar date (in the schedule's own timezone).
   *
   * Returns true if this call is the one that gets to fire the schedule for that
   * slot+date; returns false if it was already claimed (by an earlier tick today,
   * or by another concurrent worker process). This makes it safe to run several
   * schedule-checker instances in parallel without double-posting, and safe to
   * retry a late/slow tick without re-firing something already sent.
   */
  async claimSlot(id, slotKey, dateKey) {
    const res = await query(
      `UPDATE schedules
       SET last_run_slots = jsonb_set(COALESCE(last_run_slots, '{}'::jsonb), ARRAY[$2::text], to_jsonb($3::text), true),
           last_run_at = now()
       WHERE id = $1
         AND COALESCE(last_run_slots ->> $2, '') IS DISTINCT FROM $3
       RETURNING id`,
      [id, slotKey, dateKey]
    );
    return res.rows.length > 0;
  },

  /**
   * Atomically claims an interval_hours schedule for firing "now" only if enough time
   * has actually elapsed since its last run (or it has never run). Safe against
   * concurrent/overlapping checker ticks and multiple worker replicas.
   */
  async claimInterval(id, intervalSeconds) {
    const res = await query(
      `UPDATE schedules
       SET last_run_at = now()
       WHERE id = $1
         AND (last_run_at IS NULL OR now() - last_run_at >= ($2 || ' seconds')::interval)
       RETURNING id`,
      [id, intervalSeconds]
    );
    return res.rows.length > 0;
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
