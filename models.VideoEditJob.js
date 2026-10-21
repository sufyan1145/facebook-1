const { query } = require('./config.database');

const VideoEditJob = {
  async create(userId, { sourceUrl, secondaryUrl, effects, driveFolderId, driveFolderName }) {
    const res = await query(
      `INSERT INTO video_edit_jobs (user_id, source_url, secondary_url, effects_json, drive_folder_id, drive_folder_name, status)
       VALUES ($1,$2,$3,$4,$5,$6,'pending')
       RETURNING *`,
      [userId, sourceUrl, secondaryUrl || null, JSON.stringify(effects || {}), driveFolderId || null, driveFolderName || null]
    );
    return res.rows[0];
  },

  async setStatus(id, status) {
    await query('UPDATE video_edit_jobs SET status = $2, updated_at = now() WHERE id = $1', [id, status]);
  },

  async setGeneratedMetadata(id, { generatedTitle, generatedHashtags }) {
    await query(
      'UPDATE video_edit_jobs SET generated_title = $2, generated_hashtags = $3, updated_at = now() WHERE id = $1',
      [id, generatedTitle || null, generatedHashtags || null]
    );
  },

  async setGeneratedExplanation(id, explanation) {
    await query(
      'UPDATE video_edit_jobs SET generated_explanation = $2, updated_at = now() WHERE id = $1',
      [id, explanation || null]
    );
  },

  async markCompleted(id, { driveFileId = null, driveFileName = null, localFilePath = null }) {
    await query(
      `UPDATE video_edit_jobs SET status = 'completed', drive_file_id = $2, drive_file_name = $3, local_file_path = $4, updated_at = now() WHERE id = $1`,
      [id, driveFileId, driveFileName, localFilePath]
    );
  },

  async markFailed(id, errorMessage) {
    await query(`UPDATE video_edit_jobs SET status = 'failed', error_message = $2, updated_at = now() WHERE id = $1`, [id, errorMessage]);
  },

  async listByUser(userId, limit = 50) {
    const res = await query('SELECT * FROM video_edit_jobs WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2', [userId, limit]);
    return res.rows;
  },

  async findById(userId, id) {
    const res = await query('SELECT * FROM video_edit_jobs WHERE id = $1 AND user_id = $2', [id, userId]);
    return res.rows[0];
  },

  // Used by the upload worker so a Video Editor file posted by a schedule
  // gets its AI/regenerated title (and hashtags) as the caption, the same way
  // TikTok Downloader files already do.
  async findByDriveFileId(driveFileId) {
    const res = await query(
      `SELECT * FROM video_edit_jobs WHERE drive_file_id = $1 AND status = 'completed' ORDER BY created_at DESC LIMIT 1`,
      [driveFileId]
    );
    return res.rows[0];
  },

  // ---- "Make clips from a long video" ------------------------------------
  async setClipSummary(id, text) {
    await query('UPDATE video_edit_jobs SET clip_summary = $2, updated_at = now() WHERE id = $1', [id, text || null]);
  },

  // One finished clip = its own completed history entry (previewable,
  // downloadable, usable by schedules like any other Video Editor file).
  async createClipChild(parent, { id, driveFileId, driveFileName, localFilePath, generatedTitle, clipInfo, createdAt }) {
    const res = await query(
      `INSERT INTO video_edit_jobs
         (id, user_id, source_url, effects_json, drive_folder_id, drive_folder_name, status,
          drive_file_id, drive_file_name, local_file_path, generated_title, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,'completed',$7,$8,$9,$10,$11,now())
       RETURNING *`,
      [
        id, parent.user_id, parent.source_url, JSON.stringify({ clipPart: clipInfo || {} }),
        parent.drive_folder_id || null, parent.drive_folder_name || null,
        driveFileId || null, driveFileName || null, localFilePath || null,
        generatedTitle || null, createdAt || new Date(),
      ]
    );
    return res.rows[0];
  },

  // A clip batch for this video is queued/running right now (ignores rows
  // stuck for 45+ minutes, e.g. after a server restart).
  async hasActiveClipJob(userId, sourceKey) {
    const res = await query(
      `SELECT 1 FROM video_edit_jobs
        WHERE user_id = $1
          AND status IN ('pending','downloading','splitting')
          AND effects_json->'clipSplit'->>'sourceKey' = $2
          AND updated_at > now() - interval '45 minutes'
        LIMIT 1`,
      [userId, sourceKey]
    );
    return res.rows.length > 0;
  },

  async deleteById(userId, id) {
    const res = await query('DELETE FROM video_edit_jobs WHERE id = $1 AND user_id = $2 RETURNING *', [id, userId]);
    return res.rows[0];
  },

  async deleteAllForUser(userId) {
    await query('DELETE FROM video_edit_jobs WHERE user_id = $1', [userId]);
  },
};

module.exports = VideoEditJob;
