const { query } = require('./config.database');

const Settings = {
  async getOrCreate(userId) {
    let res = await query('SELECT * FROM settings WHERE user_id = $1', [userId]);
    if (res.rows[0]) return res.rows[0];
    res = await query('INSERT INTO settings (user_id) VALUES ($1) RETURNING *', [userId]);
    return res.rows[0];
  },

  async update(userId, data) {
    const res = await query(
      `UPDATE settings SET
         email_alerts = COALESCE($2, email_alerts),
         auto_retry = COALESCE($3, auto_retry),
         upload_speed = COALESCE($4, upload_speed),
         queue_size = COALESCE($5, queue_size),
         updated_at = now()
       WHERE user_id = $1 RETURNING *`,
      [userId, data.emailAlerts, data.autoRetry, data.uploadSpeed, data.queueSize]
    );
    return res.rows[0];
  },
};

module.exports = Settings;
