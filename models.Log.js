const { query } = require('./config.database');

const Log = {
  async record(userId, action, details = {}, level = 'info') {
    await query(
      'INSERT INTO logs (user_id, action, details, level) VALUES ($1,$2,$3,$4)',
      [userId, action, JSON.stringify(details), level]
    );
  },

  async listByUser(userId, { limit = 100, offset = 0 } = {}) {
    const res = await query(
      'SELECT * FROM logs WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2 OFFSET $3',
      [userId, limit, offset]
    );
    return res.rows;
  },
};

module.exports = Log;
