const { query } = require('./config.database');

// Remembers how far into a source video clips have already been cut.
const VideoClipProgress = {
  async get(userId, sourceKey) {
    const res = await query('SELECT * FROM video_clip_progress WHERE user_id = $1 AND source_key = $2', [userId, sourceKey]);
    return res.rows[0] || null;
  },

  async getOrCreate(userId, sourceKey, sourceUrl) {
    const res = await query(
      `INSERT INTO video_clip_progress (user_id, source_key, source_url)
       VALUES ($1,$2,$3)
       ON CONFLICT (user_id, source_key) DO UPDATE SET source_url = EXCLUDED.source_url, updated_at = now()
       RETURNING *`,
      [userId, sourceKey, sourceUrl]
    );
    return res.rows[0];
  },

  async setSourceInfo(id, { duration, title }) {
    await query(
      'UPDATE video_clip_progress SET source_duration = $2, source_title = COALESCE($3, source_title), updated_at = now() WHERE id = $1',
      [id, duration, title || null]
    );
  },

  // Called after each clip is safely saved, so a failure half-way keeps
  // everything that was already made and never repeats it.
  async advance(id, nextStart) {
    await query(
      'UPDATE video_clip_progress SET next_start = $2, parts_made = parts_made + 1, updated_at = now() WHERE id = $1',
      [id, nextStart]
    );
  },

  async reset(userId, sourceKey) {
    await query('DELETE FROM video_clip_progress WHERE user_id = $1 AND source_key = $2', [userId, sourceKey]);
  },
};

module.exports = VideoClipProgress;
