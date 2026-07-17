const { query } = require('./config.database');

const Notification = {
  async create(userId, { type, title, message }) {
    const res = await query(
      'INSERT INTO notifications (user_id, type, title, message) VALUES ($1,$2,$3,$4) RETURNING *',
      [userId, type, title, message]
    );
    return res.rows[0];
  },

  async listByUser(userId, { limit = 50, offset = 0 } = {}) {
    const res = await query(
      'SELECT * FROM notifications WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2 OFFSET $3',
      [userId, limit, offset]
    );
    return res.rows;
  },

  async markRead(userId, id) {
    await query('UPDATE notifications SET is_read = TRUE WHERE user_id = $1 AND id = $2', [userId, id]);
  },
};

module.exports = Notification;
