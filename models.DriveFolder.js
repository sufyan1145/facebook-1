const { query } = require('./config.database');

const DriveFolder = {
  async upsertMany(userId, folders) {
    const results = [];
    for (const f of folders) {
      const res = await query(
        `INSERT INTO drive_folders (user_id, folder_id, folder_name, video_count, storage_bytes, owner_email, last_modified)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (user_id, folder_id) DO UPDATE SET
           folder_name = EXCLUDED.folder_name,
           video_count = EXCLUDED.video_count,
           storage_bytes = EXCLUDED.storage_bytes,
           owner_email = EXCLUDED.owner_email,
           last_modified = EXCLUDED.last_modified
         RETURNING *`,
        [userId, f.folder_id, f.folder_name, f.video_count || 0, f.storage_bytes || 0, f.owner_email, f.last_modified]
      );
      results.push(res.rows[0]);
    }
    return results;
  },

  async listByUser(userId) {
    const res = await query('SELECT * FROM drive_folders WHERE user_id = $1 ORDER BY folder_name', [userId]);
    return res.rows;
  },

  async findById(userId, id) {
    const res = await query('SELECT * FROM drive_folders WHERE user_id = $1 AND id = $2', [userId, id]);
    return res.rows[0];
  },

  async search(userId, term) {
    const res = await query(
      'SELECT * FROM drive_folders WHERE user_id = $1 AND folder_name ILIKE $2 ORDER BY folder_name',
      [userId, `%${term}%`]
    );
    return res.rows;
  },

  // Clears the cached folder list for this user - used when they disconnect Drive,
  // so a stale list from a previous Google account doesn't linger after reconnecting
  // with a different one.
  async deleteAllForUser(userId) {
    await query('DELETE FROM drive_folders WHERE user_id = $1', [userId]);
  },
};

module.exports = DriveFolder;
