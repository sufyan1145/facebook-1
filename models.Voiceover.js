const { query } = require('./config.database');
const { encrypt, decrypt } = require('./utils.encryption');

const VoiceoverJob = {
  async create(userId, d) {
    const res = await query(
      `INSERT INTO voiceover_jobs (user_id, mode, title, language_code, voice_name, clone_id, voice_label, speaking_rate, pitch_semitones, char_count, est_minutes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [userId, d.mode, d.title || null, d.languageCode, d.voiceName || null, d.cloneId || null, d.voiceLabel || null,
        d.speakingRate, d.pitchSemitones, d.charCount, d.estMinutes]
    );
    return res.rows[0];
  },
  async markProcessing(id, total) {
    await query(`UPDATE voiceover_jobs SET status='processing', chunks_total=$2, chunks_done=0, updated_at=now() WHERE id=$1`, [id, total]);
  },
  async setProgress(id, done) {
    await query(`UPDATE voiceover_jobs SET chunks_done=$2, updated_at=now() WHERE id=$1`, [id, done]);
  },
  async complete(id, { filePath, seconds, bytes }) {
    await query(`UPDATE voiceover_jobs SET status='completed', file_path=$2, duration_seconds=$3, file_bytes=$4, chunks_done=chunks_total, error_message=NULL, updated_at=now() WHERE id=$1`, [id, filePath, seconds, bytes]);
  },
  async fail(id, message) {
    await query(`UPDATE voiceover_jobs SET status='failed', error_message=$2, updated_at=now() WHERE id=$1`, [id, message]);
  },
  async listByUser(userId, limit = 40) {
    const res = await query('SELECT * FROM voiceover_jobs WHERE user_id=$1 ORDER BY created_at DESC LIMIT $2', [userId, limit]);
    return res.rows;
  },
  async findById(userId, id) {
    const res = await query('SELECT * FROM voiceover_jobs WHERE user_id=$1 AND id=$2', [userId, id]);
    return res.rows[0];
  },
  async hasActive(userId) {
    const res = await query(`SELECT 1 FROM voiceover_jobs WHERE user_id=$1 AND status IN ('pending','processing') LIMIT 1`, [userId]);
    return res.rows.length > 0;
  },
  async remove(userId, id) {
    const res = await query('DELETE FROM voiceover_jobs WHERE user_id=$1 AND id=$2 RETURNING file_path', [userId, id]);
    return res.rows[0];
  },
  // Files older than `days` are deleted from disk; the row stays (file_path cleared) as history.
  async expireOld(days) {
    const res = await query(
      `UPDATE voiceover_jobs SET file_path=NULL, updated_at=now()
       WHERE file_path IS NOT NULL AND updated_at < now() - ($1 || ' days')::interval RETURNING id`, [days]);
    return res.rowCount;
  },
  async failStale() {
    const res = await query(`UPDATE voiceover_jobs SET status='failed', error_message='Interrupted by a server restart - please try again.', updated_at=now() WHERE status IN ('pending','processing')`);
    return res.rowCount;
  },
};

const VoiceClone = {
  async create(userId, { name, languageCode, key }) {
    const res = await query(
      `INSERT INTO voice_clones (user_id, name, language_code, voice_key) VALUES ($1,$2,$3,$4) RETURNING id, name, language_code, created_at`,
      [userId, name, languageCode, encrypt(key)]
    );
    return res.rows[0];
  },
  async listByUser(userId) {
    const res = await query('SELECT id, name, language_code, created_at FROM voice_clones WHERE user_id=$1 ORDER BY created_at DESC', [userId]);
    return res.rows;
  },
  async findWithKey(userId, id) {
    const res = await query('SELECT * FROM voice_clones WHERE user_id=$1 AND id=$2', [userId, id]);
    const r = res.rows[0];
    return r ? { ...r, voice_key: decrypt(r.voice_key) } : null;
  },
  async remove(userId, id) {
    await query('DELETE FROM voice_clones WHERE user_id=$1 AND id=$2', [userId, id]);
  },
};

module.exports = { VoiceoverJob, VoiceClone };
